import { Address, beginCell } from "@ton/core";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TREE_ROOT,
  LocalMerkleStateProvider,
  createFastPoseidon2,
  type Client,
  type MerkleStateProvider,
} from "@tonresistor/zkresistor-sdk";
import {
  FileMerkleStateStore,
  statePoolDirectory,
  withPersistentState,
  withPoolStateLock,
} from "../src/lib/state.js";

const POOL = Address.parseRaw(`0:${"22".repeat(32)}`).toString();

describe("FileMerkleStateStore", () => {
  it("atomically persists compact snapshots and idempotent bigint journals", async () => {
    const root = await mkdtemp(join(tmpdir(), "zkr-state-"));
    const store = new FileMerkleStateStore(root, "mainnet", POOL);
    const position = { blockSeqno: 0, transactionLt: 123n, eventIndex: 2 };
    const batch = {
      events: [],
      scannedThrough: position,
    };
    const checkpoint = {
      schemaVersion: 1 as const,
      poolAddress: POOL,
      position,
      nextIndex: 0,
      withdrawalCount: 0,
      currentRoot: 7n,
      commitmentSeenRoots: new Array<bigint>(256).fill(0n),
      nullifierSpentRoots: new Array<bigint>(256).fill(0n),
    };

    await store.appendVerifiedBatch(POOL, batch, checkpoint);
    await store.appendVerifiedBatch(POOL, batch, checkpoint);
    const restored = await store.loadVerifiedBatches(
      POOL,
      { blockSeqno: 0, transactionLt: 0n, eventIndex: 0 },
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]?.checkpoint.currentRoot).toBe(7n);
    expect(restored[0]?.checkpoint.position.transactionLt).toBe(123n);

    const bytes = [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)];
    await store.saveCompact(POOL, bytes);
    const chunks = await store.loadCompact();
    expect(chunks).not.toBeNull();
    const received: number[] = [];
    for await (const chunk of chunks!) received.push(...chunk);
    expect(received).toEqual([1, 2, 3, 4, 5]);

    await store.pruneJournalThrough(position);
    expect(await store.loadVerifiedBatches(POOL, {
      blockSeqno: 0,
      transactionLt: 0n,
      eventIndex: 0,
    })).toEqual([]);

    const snapshot = await stat(join(
      root,
      "mainnet",
      Address.parse(POOL).toRawString().replace(":", "_"),
      "snapshot.zkr",
    ));
    expect(snapshot.size).toBe(5);
  });

  it("restores a compact verified provider at its persisted replay cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "zkr-state-restart-"));
    const store = new FileMerkleStateStore(root, "mainnet", POOL);
    const head = { blockSeqno: 0, transactionLt: 99n, eventIndex: 0 };
    const target = {
      poolAddress: POOL,
      nextIndex: 0,
      withdrawalCount: 0,
      currentRoot: EMPTY_TREE_ROOT,
    };
    const chain = {
      async getMerkleHead() { return target; },
      async getSparseRoot() { return 0n; },
    };
    const first = await LocalMerkleStateProvider.create({
      poolAddress: POOL,
      poseidon2: createFastPoseidon2(),
      source: {
        async eventsAfter() { return { events: [], scannedThrough: head }; },
      },
      chain,
      store,
    });
    await first.sync(target);
    const compacted = await first.saveCompactSnapshot();
    await store.pruneJournalThrough(compacted.position);

    const replayStarts: bigint[] = [];
    const restarted = await LocalMerkleStateProvider.create({
      poolAddress: POOL,
      poseidon2: createFastPoseidon2(),
      source: {
        async eventsAfter(_pool, position) {
          replayStarts.push(position.transactionLt);
          return { events: [], scannedThrough: position };
        },
      },
      chain,
      store: new FileMerkleStateStore(root, "mainnet", POOL),
    });
    await expect(restarted.sync(target)).resolves.toMatchObject({
      nextIndex: 0,
      currentRoot: EMPTY_TREE_ROOT,
    });
    expect(replayStarts).toEqual([99n]);
  });
});

describe("verified state inter-process lock", () => {
  it("serializes two users of the same network and pool", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zkr-lock-"));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const order: string[] = [];
    const first = withPoolStateLock({
      rootDir,
      network: "mainnet",
      poolAddress: POOL,
    }, async () => {
      order.push("first-start");
      firstStarted();
      await firstGate;
      order.push("first-end");
    });
    await firstReady;
    const second = withPoolStateLock({
      rootDir,
      network: "mainnet",
      poolAddress: POOL,
      lock: { timeoutMs: 2_000, pollMs: 5 },
    }, async () => {
      order.push("second-start");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("times out without deleting a lock classified as stale", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zkr-lock-stale-"));
    const poolDir = statePoolDirectory(rootDir, "mainnet", POOL);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(poolDir, { recursive: true }));
    const lockPath = join(poolDir, ".state.lock");
    const stale = JSON.stringify({
      schemaVersion: 1,
      token: "dead-owner",
      pid: 2_147_483_647,
      hostname: (await import("node:os")).hostname(),
      createdAt: "2000-01-01T00:00:00.000Z",
    }) + "\n";
    await writeFile(lockPath, stale, { mode: 0o600 });
    await expect(withPoolStateLock({
      rootDir,
      network: "mainnet",
      poolAddress: POOL,
      lock: { timeoutMs: 0, staleAfterMs: 0 },
    }, async () => {})).rejects.toThrow(/stale lock.*never auto-removed/);
    expect(await readFile(lockPath, "utf8")).toBe(stale);
  });

  it("invalidates an escaped provider before releasing the lock", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zkr-scope-"));
    const factory = Address.parseRaw(`0:${"77".repeat(32)}`);
    const identity = beginCell().storeAddress(factory).storeCoins(1n).endCell();
    const merkle = beginCell()
      .storeUint(0, 32)
      .storeUint(EMPTY_TREE_ROOT, 256)
      .endCell();
    const data = beginCell()
      .storeRef(identity)
      .storeRef(merkle)
      .storeCoins(0n)
      .storeCoins(0n)
      .endCell()
      .toBoc()
      .toString("base64");
    const client: Client = {
      async getAccountState() {
        return { status: "active", data };
      },
      async runMethod() {
        return { exit_code: 0, stack: ["0"] };
      },
      async getTransactions() {
        return { transactions: [], incomplete: false };
      },
    };
    let escaped!: MerkleStateProvider;
    await withPersistentState({
      client,
      network: "mainnet",
      poolAddress: POOL,
      kind: "ton",
      poseidon2: createFastPoseidon2(),
      rootDir,
    }, async (state) => {
      escaped = state.provider;
      await state.provider.sync({
        poolAddress: POOL,
        nextIndex: 0,
        withdrawalCount: 0,
        currentRoot: EMPTY_TREE_ROOT,
      });
      await state.compact();
    });
    await expect(escaped.checkpoint()).rejects.toThrow(
      /scope has already been released/,
    );
  });
});
