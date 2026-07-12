import { beginCell } from "@ton/core";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emitError } from "../src/lib/output.js";
import {
  PendingDepositError,
  pendingDepositErrorPayload,
  pendingDepositJournalPath,
  pendingDepositPayloadHash,
  readPendingDepositJournal,
  recoverPendingDepositJournals,
  submitPendingDeposit,
  type PendingDepositJournalV2,
  type PendingDepositJournalStore,
} from "../src/lib/pending-deposit.js";

const NOTE = "zkresistor:do-not-put-this-secret-in-a-file-name";
const POOL = `EQ${"a".repeat(46)}`;
const WALLET = `UQ${"b".repeat(46)}`;
const TARGET = `EQ${"c".repeat(46)}`;
const JOURNAL_SECRET = Buffer.alloc(64, 0x42);

function submit(options: Parameters<typeof submitPendingDeposit>[0]) {
  return submitPendingDeposit({ journalSecret: JOURNAL_SECRET, ...options });
}

function payload() {
  return beginCell().storeUint(0x00de9052, 32).storeUint(123n, 256).endCell();
}

async function readJournal(path: string): Promise<PendingDepositJournalV2> {
  return JSON.parse(await readFile(path, "utf8")) as PendingDepositJournalV2;
}

describe("pending deposit journal", () => {
  it("persists prepared before send, then atomically keeps submitted at mode 0600", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zkr-pending-success-"));
    const rootDir = join(parent, "pending-deposits");
    const body = payload();
    const payloadHash = pendingDepositPayloadHash(body);
    const expectedPath = pendingDepositJournalPath(rootDir, "mainnet", payloadHash);
    const times = [
      new Date("2026-07-10T10:00:00.000Z"),
      new Date("2026-07-10T10:00:01.000Z"),
    ];
    const observed: string[] = [];

    const result = await submit({
      network: "mainnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 17,
      target: TARGET,
      value: 10_350_000_000n,
      payload: body,
      note: NOTE,
      rootDir,
      now: () => times.shift()!,
      send: async () => {
        const duringSend = await readJournal(expectedPath);
        observed.push(duringSend.phase);
        expect(duringSend.schemaVersion).toBe(2);
        expect(JSON.stringify(duringSend)).not.toContain(NOTE);
        expect((await readPendingDepositJournal(expectedPath, JOURNAL_SECRET)).note).toBe(NOTE);
        expect(duringSend.timestamps).toEqual({
          preparedAt: "2026-07-10T10:00:00.000Z",
          submittedAt: null,
        });
      },
    });

    expect(observed).toEqual(["prepared"]);
    expect(result).toEqual({ journalPath: expectedPath, payloadHash });
    const final = await readJournal(expectedPath);
    expect(final).toMatchObject({
      schemaVersion: 2,
      network: "mainnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 17,
      target: TARGET,
      value: "10350000000",
      payloadHash,
      timestamps: {
        preparedAt: "2026-07-10T10:00:00.000Z",
        submittedAt: "2026-07-10T10:00:01.000Z",
      },
      phase: "submitted",
    });
    expect(JSON.stringify(final)).not.toContain(NOTE);
    await expect(readPendingDepositJournal(expectedPath, Buffer.alloc(64, 1)))
      .rejects.toThrow("journal decryption failed");
    expect((await readPendingDepositJournal(expectedPath, JOURNAL_SECRET)).note).toBe(NOTE);
    expect(await recoverPendingDepositJournals({
      wallet: WALLET,
      journalSecret: JOURNAL_SECRET,
      rootDir,
    })).toMatchObject({
      journals: [{
        path: expectedPath,
        entry: { note: NOTE, phase: "submitted" },
      }],
      warnings: [],
    });

    expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(rootDir, "mainnet"))).mode & 0o777).toBe(0o700);
    expect((await stat(expectedPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(rootDir, "mainnet"))).toEqual([`${payloadHash}.json`]);
    expect(basename(expectedPath)).not.toContain("do-not-put-this-secret");
  });

  it("recovers legacy plaintext journals without writing new plaintext notes", async () => {
    const rootDir = join(await mkdtemp(join(tmpdir(), "zkr-pending-legacy-")), "pending-deposits");
    const networkDir = join(rootDir, "mainnet");
    await mkdir(networkDir, { recursive: true });
    const payloadHash = "a".repeat(64);
    const path = pendingDepositJournalPath(rootDir, "mainnet", payloadHash);
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      network: "mainnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 1,
      target: TARGET,
      value: "1",
      payloadHash,
      note: NOTE,
      timestamps: {
        preparedAt: "2026-07-10T10:00:00.000Z",
        submittedAt: "2026-07-10T10:00:01.000Z",
      },
      phase: "submitted",
    }));
    expect(await recoverPendingDepositJournals({
      wallet: WALLET,
      journalSecret: JOURNAL_SECRET,
      rootDir,
    })).toMatchObject({ journals: [{ entry: { note: NOTE, schemaVersion: 1 } }], warnings: [] });
    const migrated = await readFile(path, "utf8");
    expect(migrated).not.toContain(NOTE);
    expect(JSON.parse(migrated)).toMatchObject({ schemaVersion: 2, wallet: WALLET });
  });

  it("recovers valid notes even when another journal is corrupted", async () => {
    const rootDir = join(await mkdtemp(join(tmpdir(), "zkr-pending-corrupt-")), "pending-deposits");
    const body = payload();
    await submit({
      network: "mainnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 1,
      target: TARGET,
      value: 1n,
      payload: body,
      note: NOTE,
      rootDir,
      send: async () => {},
    });
    const corruptPath = join(rootDir, "mainnet", `${"b".repeat(64)}.json`);
    await writeFile(corruptPath, "not json", "utf8");
    const recovered = await recoverPendingDepositJournals({
      wallet: WALLET,
      journalSecret: JOURNAL_SECRET,
      rootDir,
    });
    expect(recovered.journals).toHaveLength(1);
    expect(recovered.journals[0]?.entry.note).toBe(NOTE);
    expect(recovered.warnings).toEqual([{
      path: corruptPath,
      message: "Journal metadata is invalid.",
    }]);
  });

  it("never calls send when the prepared journal cannot be created", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zkr-pending-blocked-"));
    const rootDir = join(parent, "not-a-directory");
    await writeFile(rootDir, "blocked", "utf8");
    const send = vi.fn(async () => {});

    const promise = submit({
      network: "testnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 0,
      target: TARGET,
      value: 1n,
      payload: payload(),
      note: NOTE,
      rootDir,
      send,
    });
    await expect(promise).rejects.toMatchObject({
      code: "DEPOSIT_JOURNAL_FAILED",
      failure: "prepare",
      note: NOTE,
      journalPhase: "not-written",
      broadcastStatus: "not-attempted",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps prepared and exposes note plus journal path when send is ambiguous", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zkr-pending-ambiguous-"));
    const rootDir = join(parent, "pending-deposits");
    let failure: PendingDepositError | undefined;
    try {
      await submit({
        network: "mainnet",
        pool: POOL,
        wallet: WALLET,
        expectedLeafIndex: 9,
        target: TARGET,
        value: 42n,
        payload: payload(),
        note: NOTE,
        rootDir,
        send: async () => {
          throw new Error("RPC connection closed after submission");
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PendingDepositError);
      failure = error as PendingDepositError;
    }

    expect(failure).toMatchObject({
      code: "DEPOSIT_BROADCAST_AMBIGUOUS",
      failure: "broadcast",
      note: NOTE,
      journalPhase: "prepared",
      broadcastStatus: "unknown",
    });
    expect((await readJournal(failure!.journalPath)).phase).toBe("prepared");
    expect(pendingDepositErrorPayload(failure!)).toMatchObject({
      ok: false,
      error: "DEPOSIT_BROADCAST_AMBIGUOUS",
      note: NOTE,
      journalPath: failure!.journalPath,
      journalPhase: "prepared",
      broadcastStatus: "unknown",
    });

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write,
    );
    try {
      expect(emitError(failure, { json: true })).toBe(1);
    } finally {
      stdout.mockRestore();
    }
    const cliError = JSON.parse(writes.join("")) as {
      details: Record<string, unknown>;
    };
    expect(cliError.details).toMatchObject({
      note: NOTE,
      journal_path: failure!.journalPath,
      journal_phase: "prepared",
      broadcast_status: "unknown",
    });
  });

  it("does not resend a payload whose durable journal already exists", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zkr-pending-repeat-"));
    const rootDir = join(parent, "pending-deposits");
    const body = payload();
    await submit({
      network: "mainnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 1,
      target: TARGET,
      value: 5n,
      payload: body,
      note: NOTE,
      rootDir,
      send: async () => {},
    });
    const secondSend = vi.fn(async () => {});
    await expect(submit({
      network: "mainnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 1,
      target: TARGET,
      value: 5n,
      payload: body,
      note: NOTE,
      rootDir,
      send: secondSend,
    })).rejects.toMatchObject({
      code: "DEPOSIT_JOURNAL_FAILED",
      failure: "prepare",
      broadcastStatus: "not-attempted",
    });
    expect(secondSend).not.toHaveBeenCalled();
  });

  it("allows only one concurrent process to publish and send a payload", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zkr-pending-concurrent-"));
    const rootDir = join(parent, "pending-deposits");
    const send = vi.fn(async () => {});
    const options = {
      network: "mainnet" as const,
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 1,
      target: TARGET,
      value: 5n,
      payload: payload(),
      note: NOTE,
      rootDir,
      send,
    };

    const results = await Promise.allSettled([
      submit(options),
      submit(options),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports a returned broadcast without retrying when submitted marking fails", async () => {
    const calls: string[] = [];
    const store: PendingDepositJournalStore = {
      async prepare() {
        calls.push("prepare");
        return "/durable/payload.json";
      },
      async markSubmitted() {
        calls.push("mark-submitted");
        throw new Error("disk full");
      },
    };

    await expect(submit({
      network: "mainnet",
      pool: POOL,
      wallet: WALLET,
      expectedLeafIndex: 2,
      target: TARGET,
      value: 7n,
      payload: payload(),
      note: NOTE,
      store,
      send: async () => {
        calls.push("send");
      },
    })).rejects.toMatchObject({
      code: "DEPOSIT_JOURNAL_FAILED",
      failure: "submit-journal",
      journalPhase: "prepared",
      broadcastStatus: "returned",
      journalPath: "/durable/payload.json",
      note: NOTE,
    });
    expect(calls).toEqual(["prepare", "send", "mark-submitted"]);
  });
});
