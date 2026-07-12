import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
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

export interface PendingDepositJournalV2 extends Omit<PendingDepositJournalV1, "schemaVersion" | "note"> {
  schemaVersion: 2;
  encryptedNote: {
    cipher: "aes-256-gcm";
    ivBase64: string;
    ciphertextBase64: string;
    authTagBase64: string;
  };
}

type StoredPendingDepositJournal = PendingDepositJournalV1 | PendingDepositJournalV2;

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
  /** Wallet secret material used only to encrypt the durable note journal. */
  journalSecret?: Uint8Array;
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
  constructor(
    private readonly rootDir = pendingDepositsRoot(),
    private readonly journalSecret: Uint8Array,
  ) {
    if (journalSecret.byteLength < 32) {
      throw new Error("pending deposit journal encryption secret is invalid");
    }
  }

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
    await atomicWriteJson(networkDir, destination, encryptEntry(entry, this.journalSecret), false);
    return destination;
  }

  async markSubmitted(path: string, submittedAt: string): Promise<void> {
    const existing = parseStoredEntry(await readFile(path, "utf8"));
    if (existing.phase === "submitted") return;
    const updated: StoredPendingDepositJournal = {
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
  const store = options.store ?? new FilePendingDepositJournalStore(
    rootDir,
    options.journalSecret ?? new Uint8Array(),
  );
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
  value: StoredPendingDepositJournal,
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

export async function readPendingDepositJournal(
  path: string,
  journalSecret: Uint8Array,
): Promise<PendingDepositJournalV1> {
  const stored = parseStoredEntry(await readFile(path, "utf8"));
  return decryptStoredEntry(stored, journalSecret);
}

function decryptStoredEntry(
  stored: StoredPendingDepositJournal,
  journalSecret: Uint8Array,
): PendingDepositJournalV1 {
  if (stored.schemaVersion === 1) return stored;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    journalEncryptionKey(journalSecret),
    decodeFixedBase64(stored.encryptedNote.ivBase64, 12, "journal IV"),
  );
  decipher.setAAD(journalAad(stored));
  decipher.setAuthTag(decodeFixedBase64(stored.encryptedNote.authTagBase64, 16, "journal auth tag"));
  let note: string;
  try {
    note = Buffer.concat([
      decipher.update(Buffer.from(stored.encryptedNote.ciphertextBase64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("pending deposit journal decryption failed");
  }
  const { encryptedNote, ...metadata } = stored;
  void encryptedNote;
  const entry: PendingDepositJournalV1 = {
    ...metadata,
    schemaVersion: 1,
    note,
  };
  validateEntry(entry);
  return entry;
}

export async function recoverPendingDepositJournals(options: {
  wallet: string;
  journalSecret: Uint8Array;
  rootDir?: string;
}): Promise<{
  journals: Array<{ path: string; entry: PendingDepositJournalV1 }>;
  warnings: Array<{ path: string; message: string }>;
}> {
  const rootDir = options.rootDir ?? pendingDepositsRoot();
  const recovered: Array<{ path: string; entry: PendingDepositJournalV1 }> = [];
  const warnings: Array<{ path: string; message: string }> = [];
  for (const network of ["mainnet", "testnet"] as const) {
    const directory = join(rootDir, network);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((value) => /^[0-9a-f]{64}\.json$/.test(value)).sort()) {
      const path = join(directory, name);
      let stored: StoredPendingDepositJournal;
      try {
        const input = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (
          typeof input === "object" &&
          input !== null &&
          typeof (input as { wallet?: unknown }).wallet === "string" &&
          (input as { wallet: string }).wallet !== options.wallet
        ) continue;
        validateStoredEntry(input);
        stored = input;
      } catch {
        warnings.push({ path, message: "Journal metadata is invalid." });
        continue;
      }
      let entry: PendingDepositJournalV1;
      try {
        entry = decryptStoredEntry(stored, options.journalSecret);
      } catch {
        warnings.push({ path, message: "Journal decryption failed." });
        continue;
      }
      recovered.push({ path, entry });
      if (stored.schemaVersion === 1) {
        try {
          await atomicWriteJson(directory, path, encryptEntry(entry, options.journalSecret), true);
        } catch {
          warnings.push({ path, message: "Legacy journal could not be re-encrypted." });
        }
      }
    }
  }
  return {
    journals: recovered.sort((left, right) =>
      left.entry.timestamps.preparedAt.localeCompare(right.entry.timestamps.preparedAt)),
    warnings,
  };
}

function parseStoredEntry(serialized: string): StoredPendingDepositJournal {
  const parsed = JSON.parse(serialized) as unknown;
  validateStoredEntry(parsed);
  return parsed;
}

function encryptEntry(
  entry: PendingDepositJournalV1,
  journalSecret: Uint8Array,
): PendingDepositJournalV2 {
  validateEntry(entry);
  const iv = randomBytes(12);
  const encrypted: PendingDepositJournalV2 = {
    schemaVersion: 2,
    network: entry.network,
    pool: entry.pool,
    wallet: entry.wallet,
    expectedLeafIndex: entry.expectedLeafIndex,
    target: entry.target,
    value: entry.value,
    payloadHash: entry.payloadHash,
    timestamps: entry.timestamps,
    phase: entry.phase,
    encryptedNote: {
      cipher: "aes-256-gcm",
      ivBase64: iv.toString("base64"),
      ciphertextBase64: "",
      authTagBase64: "",
    },
  };
  const cipher = createCipheriv("aes-256-gcm", journalEncryptionKey(journalSecret), iv);
  cipher.setAAD(journalAad(encrypted));
  encrypted.encryptedNote.ciphertextBase64 = Buffer.concat([
    cipher.update(entry.note, "utf8"),
    cipher.final(),
  ]).toString("base64");
  encrypted.encryptedNote.authTagBase64 = cipher.getAuthTag().toString("base64");
  return encrypted;
}

function journalEncryptionKey(secret: Uint8Array): Buffer {
  if (secret.byteLength < 32) throw new Error("pending deposit journal encryption secret is invalid");
  return Buffer.from(hkdfSync(
    "sha256",
    secret,
    Buffer.from("zkresistor-cli", "utf8"),
    Buffer.from("pending-deposit-journal-v2", "utf8"),
    32,
  ));
}

function journalAad(entry: Omit<PendingDepositJournalV2, "encryptedNote">): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 2,
    network: entry.network,
    pool: entry.pool,
    wallet: entry.wallet,
    expectedLeafIndex: entry.expectedLeafIndex,
    target: entry.target,
    value: entry.value,
    payloadHash: entry.payloadHash,
  }), "utf8");
}

function validateStoredEntry(value: unknown): asserts value is StoredPendingDepositJournal {
  if (typeof value !== "object" || value === null) {
    throw new Error("pending deposit journal is not an object");
  }
  if ((value as { schemaVersion?: unknown }).schemaVersion === 1) {
    validateEntry(value);
    return;
  }
  const entry = value as Partial<PendingDepositJournalV2>;
  if (
    entry.schemaVersion !== 2 ||
    (entry.network !== "mainnet" && entry.network !== "testnet") ||
    typeof entry.pool !== "string" ||
    typeof entry.wallet !== "string" ||
    !Number.isSafeInteger(entry.expectedLeafIndex) ||
    (entry.expectedLeafIndex ?? -1) < 0 ||
    typeof entry.target !== "string" ||
    typeof entry.value !== "string" ||
    !/^\d+$/.test(entry.value) ||
    typeof entry.payloadHash !== "string" ||
    (entry.phase !== "prepared" && entry.phase !== "submitted") ||
    typeof entry.timestamps !== "object" ||
    entry.timestamps === null ||
    typeof entry.timestamps.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.timestamps.preparedAt)) ||
    (entry.timestamps.submittedAt !== null &&
      (typeof entry.timestamps.submittedAt !== "string" ||
        !Number.isFinite(Date.parse(entry.timestamps.submittedAt)))) ||
    typeof entry.encryptedNote !== "object" ||
    entry.encryptedNote === null ||
    entry.encryptedNote.cipher !== "aes-256-gcm" ||
    typeof entry.encryptedNote.ciphertextBase64 !== "string"
  ) {
    throw new Error("pending deposit journal does not match schema v2");
  }
  assertPayloadHash(entry.payloadHash);
  decodeFixedBase64(entry.encryptedNote.ivBase64, 12, "journal IV");
  decodeFixedBase64(entry.encryptedNote.authTagBase64, 16, "journal auth tag");
  if (entry.phase === "prepared" && entry.timestamps.submittedAt !== null) {
    throw new Error("prepared pending deposit journal has a submitted timestamp");
  }
  if (entry.phase === "submitted" && entry.timestamps.submittedAt === null) {
    throw new Error("submitted pending deposit journal has no submitted timestamp");
  }
}

function decodeFixedBase64(value: unknown, bytes: number, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} is invalid`);
  }
  return decoded;
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
