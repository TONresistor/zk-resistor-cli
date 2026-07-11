import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cell } from "@ton/core";
import { CliError } from "./errors.js";
import type { Network } from "./network.js";

export type PendingDepositPhase = "prepared" | "submitted";

export interface PendingDepositJournalV1 {
  schemaVersion: 1;
  network: Network;
  pool: string;
  wallet: string;
  expectedLeafIndex: number;
  target: string;
  value: string;
  payloadHash: string;
  note: string;
  timestamps: {
    preparedAt: string;
    submittedAt: string | null;
  };
  phase: PendingDepositPhase;
}

export interface PendingDepositJournalStore {
  prepare(entry: PendingDepositJournalV1): Promise<string>;
  markSubmitted(path: string, submittedAt: string): Promise<void>;
}

export interface SubmitPendingDepositOptions {
  network: Network;
  pool: string;
  wallet: string;
  expectedLeafIndex: number;
  target: string;
  value: bigint;
  payload: Cell;
  note: string;
  send(): Promise<void>;
  /** Full pending-deposits directory. Defaults to ~/.config/zkresistor/pending-deposits. */
  rootDir?: string;
  store?: PendingDepositJournalStore;
  now?: () => Date;
}

export interface SubmittedDeposit {
  journalPath: string;
  payloadHash: string;
}

type DepositSubmissionFailure = "prepare" | "broadcast" | "submit-journal";

export class PendingDepositError extends CliError {
  readonly failure: DepositSubmissionFailure;
  readonly note: string;
  readonly journalPath: string;
  readonly payloadHash: string;
  readonly journalPhase: PendingDepositPhase | "not-written";
  readonly broadcastStatus: "not-attempted" | "unknown" | "returned";

  constructor(options: {
    failure: DepositSubmissionFailure;
    note: string;
    journalPath: string;
    payloadHash: string;
    cause: unknown;
  }) {
    const ambiguous = options.failure === "broadcast";
    const broadcastReturned = options.failure === "submit-journal";
    const journalPhase = options.failure === "prepare" ? "not-written" : "prepared";
    const broadcastStatus = ambiguous
      ? "unknown"
      : broadcastReturned
        ? "returned"
        : "not-attempted";
    const causeMessage = errorMessage(options.cause);
    const message = ambiguous
      ? "Deposit broadcast result is unknown. Do not retry it blindly."
      : broadcastReturned
        ? "Deposit broadcast returned, but its journal could not be marked submitted. Do not broadcast it again."
        : "Deposit was not broadcast because its secret note journal could not be persisted.";
    super(message, {
      code: ambiguous ? "DEPOSIT_BROADCAST_AMBIGUOUS" : "DEPOSIT_JOURNAL_FAILED",
      hint: ambiguous || broadcastReturned
        ? "Keep the note and inspect the wallet transaction history before taking further action."
        : "Keep the note, fix the local journal error, then prepare a new deposit.",
      details: {
        note: options.note,
        journal_path: options.journalPath,
        payload_hash: options.payloadHash,
        journal_phase: journalPhase,
        broadcast_status: broadcastStatus,
        cause: causeMessage,
      },
    });
    this.failure = options.failure;
    this.note = options.note;
    this.journalPath = options.journalPath;
    this.payloadHash = options.payloadHash;
    this.journalPhase = journalPhase;
    this.broadcastStatus = broadcastStatus;
  }
}

export function isPendingDepositError(error: unknown): error is PendingDepositError {
  return error instanceof PendingDepositError;
}

export function pendingDepositErrorPayload(error: PendingDepositError) {
  return {
    ok: false,
    error: error.code,
    message: error.message,
    note: error.note,
    journalPath: error.journalPath,
    payloadHash: error.payloadHash,
    journalPhase: error.journalPhase,
    broadcastStatus: error.broadcastStatus,
  } as const;
}

export function pendingDepositsRoot(): string {
  return join(homedir(), ".config", "zkresistor", "pending-deposits");
}

export function pendingDepositPayloadHash(payload: Cell): string {
  return payload.hash().toString("hex");
}

export function pendingDepositJournalPath(
  rootDir: string,
  network: Network,
  payloadHash: string,
): string {
  assertPayloadHash(payloadHash);
  return join(rootDir, network, `${payloadHash}.json`);
}

export class FilePendingDepositJournalStore implements PendingDepositJournalStore {
  constructor(private readonly rootDir = pendingDepositsRoot()) {}

  async prepare(entry: PendingDepositJournalV1): Promise<string> {
    validateEntry(entry);
    const networkDir = await this.ensureDirectories(entry.network);
    const destination = pendingDepositJournalPath(
      this.rootDir,
      entry.network,
      entry.payloadHash,
    );
    try {
      await readFile(destination, "utf8");
      throw new Error(`pending deposit journal already exists at ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWriteJson(networkDir, destination, entry, false);
    return destination;
  }

  async markSubmitted(path: string, submittedAt: string): Promise<void> {
    const existing = parseEntry(await readFile(path, "utf8"));
    if (existing.phase === "submitted") return;
    const updated: PendingDepositJournalV1 = {
      ...existing,
      timestamps: {
        ...existing.timestamps,
        submittedAt,
      },
      phase: "submitted",
    };
    const networkDir = join(this.rootDir, existing.network);
    await atomicWriteJson(networkDir, path, updated, true);
  }

  private async ensureDirectories(network: Network): Promise<string> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    const networkDir = join(this.rootDir, network);
    await mkdir(networkDir, { recursive: true, mode: 0o700 });
    await chmod(networkDir, 0o700);
    return networkDir;
  }
}

export async function submitPendingDeposit(
  options: SubmitPendingDepositOptions,
): Promise<SubmittedDeposit> {
  const payloadHash = pendingDepositPayloadHash(options.payload);
  const rootDir = options.rootDir ?? pendingDepositsRoot();
  const journalPath = pendingDepositJournalPath(rootDir, options.network, payloadHash);
  const store = options.store ?? new FilePendingDepositJournalStore(rootDir);
  const now = options.now ?? (() => new Date());
  const preparedAt = now().toISOString();
  const entry: PendingDepositJournalV1 = {
    schemaVersion: 1,
    network: options.network,
    pool: options.pool,
    wallet: options.wallet,
    expectedLeafIndex: options.expectedLeafIndex,
    target: options.target,
    value: options.value.toString(),
    payloadHash,
    note: options.note,
    timestamps: {
      preparedAt,
      submittedAt: null,
    },
    phase: "prepared",
  };

  let persistedPath: string;
  try {
    persistedPath = await store.prepare(entry);
  } catch (cause) {
    throw new PendingDepositError({
      failure: "prepare",
      note: options.note,
      journalPath,
      payloadHash,
      cause,
    });
  }

  try {
    await options.send();
  } catch (cause) {
    throw new PendingDepositError({
      failure: "broadcast",
      note: options.note,
      journalPath: persistedPath,
      payloadHash,
      cause,
    });
  }

  try {
    await store.markSubmitted(persistedPath, now().toISOString());
  } catch (cause) {
    throw new PendingDepositError({
      failure: "submit-journal",
      note: options.note,
      journalPath: persistedPath,
      payloadHash,
      cause,
    });
  }

  return { journalPath: persistedPath, payloadHash };
}

async function atomicWriteJson(
  directory: string,
  destination: string,
  value: PendingDepositJournalV1,
  overwrite: boolean,
): Promise<void> {
  const temporary = join(directory, `.pending-deposit-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (overwrite) {
      await rename(temporary, destination);
    } else {
      await link(temporary, destination);
      await unlink(temporary);
    }
    await chmod(destination, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseEntry(serialized: string): PendingDepositJournalV1 {
  const parsed = JSON.parse(serialized) as unknown;
  validateEntry(parsed);
  return parsed;
}

function validateEntry(value: unknown): asserts value is PendingDepositJournalV1 {
  if (typeof value !== "object" || value === null) {
    throw new Error("pending deposit journal is not an object");
  }
  const entry = value as Partial<PendingDepositJournalV1>;
  if (
    entry.schemaVersion !== 1 ||
    (entry.network !== "mainnet" && entry.network !== "testnet") ||
    typeof entry.pool !== "string" ||
    typeof entry.wallet !== "string" ||
    !Number.isSafeInteger(entry.expectedLeafIndex) ||
    (entry.expectedLeafIndex ?? -1) < 0 ||
    typeof entry.target !== "string" ||
    typeof entry.value !== "string" ||
    !/^\d+$/.test(entry.value) ||
    typeof entry.payloadHash !== "string" ||
    typeof entry.note !== "string" ||
    (entry.phase !== "prepared" && entry.phase !== "submitted") ||
    typeof entry.timestamps !== "object" ||
    entry.timestamps === null ||
    typeof entry.timestamps.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.timestamps.preparedAt)) ||
    (entry.timestamps.submittedAt !== null &&
      (typeof entry.timestamps.submittedAt !== "string" ||
        !Number.isFinite(Date.parse(entry.timestamps.submittedAt))))
  ) {
    throw new Error("pending deposit journal does not match schema v1");
  }
  assertPayloadHash(entry.payloadHash);
  if (entry.phase === "prepared" && entry.timestamps.submittedAt !== null) {
    throw new Error("prepared pending deposit journal has a submitted timestamp");
  }
  if (entry.phase === "submitted" && entry.timestamps.submittedAt === null) {
    throw new Error("submitted pending deposit journal has no submitted timestamp");
  }
}

function assertPayloadHash(payloadHash: string): void {
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) {
    throw new Error("invalid pending deposit payload hash");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
