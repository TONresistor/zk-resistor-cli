import { Address } from "@ton/core";
import {
  LocalMerkleStateProvider,
  Pool,
  TonPool,
  createClientEventSource,
  type Client,
  type LocalMerkleStateProvider as LocalProvider,
  type MerkleStateCheckpoint,
  type MerkleStateEventBatch,
  type MerkleStateProvider,
  type MerkleStateSnapshotStore,
  type PersistedMerkleStateBatch,
  type Poseidon2,
  type ReplayPosition,
} from "@tonresistor/zkresistor-sdk";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Network } from "./network.js";
import { syncDirectory } from "./fs.js";

const ADDRESS_FORMAT = { urlSafe: true, bounceable: true } as const;
const BIGINT_TAG = "$zkr_bigint";
const SNAPSHOT_CHUNK_SIZE = 1024 * 1024;
export const STATE_LOCK_TIMEOUT_MS = 120_000;
export const STATE_LOCK_POLL_MS = 100;
export const STATE_LOCK_STALE_AFTER_MS = 15 * 60_000;

interface StateLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  staleAfterMs?: number;
}

interface StateLockOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

function comparePosition(a: ReplayPosition, b: ReplayPosition): number {
  if (a.transactionLt !== b.transactionLt) {
    return a.transactionLt < b.transactionLt ? -1 : 1;
  }
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  return a.blockSeqno - b.blockSeqno;
}

function serializeJournal(value: PersistedMerkleStateBatch): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? { [BIGINT_TAG]: entry.toString() } : entry);
}

function parseJournal(serialized: string): PersistedMerkleStateBatch {
  return JSON.parse(serialized, (_key, entry: unknown) => {
    if (
      typeof entry === "object" &&
      entry !== null &&
      Object.keys(entry).length === 1 &&
      BIGINT_TAG in entry
    ) {
      const raw = (entry as Record<string, unknown>)[BIGINT_TAG];
      if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
        throw new Error("state journal contains an invalid bigint");
      }
      return BigInt(raw);
    }
    return entry;
  }) as PersistedMerkleStateBatch;
}

function poolKey(poolAddress: string): string {
  return Address.parse(poolAddress).toRawString().replace(":", "_");
}

export function statePoolDirectory(
  rootDir: string,
  network: Network,
  poolAddress: string,
): string {
  return join(rootDir, network, poolKey(poolAddress));
}

function validateLockTiming(options: StateLockOptions): Required<StateLockOptions> {
  const timing = {
    timeoutMs: options.timeoutMs ?? STATE_LOCK_TIMEOUT_MS,
    pollMs: options.pollMs ?? STATE_LOCK_POLL_MS,
    staleAfterMs: options.staleAfterMs ?? STATE_LOCK_STALE_AFTER_MS,
  };
  if (!Number.isFinite(timing.timeoutMs) || timing.timeoutMs < 0) {
    throw new RangeError("state lock timeout must be a non-negative duration");
  }
  if (!Number.isFinite(timing.pollMs) || timing.pollMs <= 0) {
    throw new RangeError("state lock poll interval must be positive");
  }
  if (!Number.isFinite(timing.staleAfterMs) || timing.staleAfterMs < 0) {
    throw new RangeError("state lock stale threshold must be non-negative");
  }
  return timing;
}

function parseLockOwner(serialized: string): StateLockOwner | null {
  try {
    const owner = JSON.parse(serialized) as Partial<StateLockOwner>;
    if (
      owner.schemaVersion !== 1 ||
      typeof owner.token !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      typeof owner.hostname !== "string" ||
      typeof owner.createdAt !== "string" ||
      !Number.isFinite(Date.parse(owner.createdAt))
    ) return null;
    return owner as StateLockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function lockDescription(
  lockPath: string,
  staleAfterMs: number,
): Promise<string> {
  const serialized = await readIfPresent(lockPath);
  if (serialized === null) return "lock owner disappeared";
  const owner = parseLockOwner(serialized);
  if (owner === null) return `lock metadata is malformed at ${lockPath}`;
  const ageMs = Math.max(0, Date.now() - Date.parse(owner.createdAt));
  const sameHost = owner.hostname === hostname();
  const dead = sameHost && !processIsAlive(owner.pid);
  const stale = dead && ageMs >= staleAfterMs;
  if (stale) {
    return `stale lock from dead pid ${owner.pid} (${owner.hostname}) at ${lockPath}; ` +
      "locks are never auto-removed, so remove it only after confirming no state process is running";
  }
  return `held by pid ${owner.pid} on ${owner.hostname} since ${owner.createdAt}`;
}

async function acquirePoolStateLock(
  poolDir: string,
  options: StateLockOptions = {},
): Promise<() => Promise<void>> {
  const timing = validateLockTiming(options);
  await mkdir(poolDir, { recursive: true, mode: 0o700 });
  await chmod(poolDir, 0o700);
  const lockPath = join(poolDir, ".state.lock");
  const owner: StateLockOwner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + timing.timeoutMs;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (handle === null) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner) + "\n", "utf8");
        await handle.sync();
        await syncDirectory(poolDir);
      } catch (error) {
        await handle.close();
        handle = null;
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for the verified state lock: ${await lockDescription(
            lockPath,
            timing.staleAfterMs,
          )}`,
        );
      }
      await delay(Math.min(timing.pollMs, remaining));
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const current = await readIfPresent(lockPath);
      const currentOwner = current === null ? null : parseLockOwner(current);
      if (currentOwner?.token !== owner.token) {
        throw new Error("verified state lock ownership changed before release");
      }
      await unlink(lockPath);
      await syncDirectory(poolDir);
    } finally {
      await handle.close();
    }
  };
}

export async function withPoolStateLock<T>(options: {
  rootDir: string;
  network: Network;
  poolAddress: string;
  lock?: StateLockOptions;
}, operation: () => Promise<T>): Promise<T> {
  const release = await acquirePoolStateLock(
    statePoolDirectory(options.rootDir, options.network, options.poolAddress),
    options.lock,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

function journalName(position: ReplayPosition): string {
  return [
    position.transactionLt.toString().padStart(20, "0"),
    position.eventIndex.toString().padStart(10, "0"),
    position.blockSeqno.toString().padStart(10, "0"),
  ].join("-") + ".json";
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten === 0) throw new Error("snapshot write made no progress");
    offset += bytesWritten;
  }
}

export class FileMerkleStateStore implements MerkleStateSnapshotStore {
  private readonly poolDir: string;
  private readonly journalDir: string;
  private readonly snapshotPath: string;

  constructor(
    rootDir: string,
    network: Network,
    poolAddress: string,
  ) {
    this.poolDir = statePoolDirectory(rootDir, network, poolAddress);
    this.journalDir = join(this.poolDir, "journal");
    this.snapshotPath = join(this.poolDir, "snapshot.zkr");
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.journalDir, { recursive: true, mode: 0o700 });
    await chmod(this.poolDir, 0o700);
    await chmod(this.journalDir, 0o700);
  }

  async loadCompact(): Promise<AsyncIterable<Uint8Array> | null> {
    try {
      await stat(this.snapshotPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return createReadStream(this.snapshotPath, { highWaterMark: SNAPSHOT_CHUNK_SIZE });
  }

  async saveCompact(
    _poolAddress: string,
    chunks: Iterable<Uint8Array>,
  ): Promise<void> {
    await this.ensureDirectories();
    const temporary = join(this.poolDir, `.snapshot-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      for (const chunk of chunks) await writeAll(handle, chunk);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    await rename(temporary, this.snapshotPath);
    await chmod(this.snapshotPath, 0o600);
    await syncDirectory(this.poolDir);
  }

  async appendVerifiedBatch(
    _poolAddress: string,
    batch: MerkleStateEventBatch,
    checkpoint: MerkleStateCheckpoint,
  ): Promise<void> {
    await this.ensureDirectories();
    const serialized = serializeJournal({ batch, checkpoint });
    const destination = join(this.journalDir, journalName(checkpoint.position));
    const existing = await readIfPresent(destination);
    if (existing !== null && existing !== serialized) {
      throw new Error("state journal position already contains different data");
    }
    if (existing !== null) {
      return;
    }

    const temporary = join(this.journalDir, `.batch-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await handle.close();
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await readFile(destination, "utf8");
      if (concurrent !== serialized) {
        throw new Error("concurrent state journal write disagrees at checkpoint");
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
    await syncDirectory(this.journalDir);
  }

  async needsCompaction(): Promise<boolean> {
    try {
      await stat(this.snapshotPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    try {
      const names = await readdir(this.journalDir);
      return names.some((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async loadVerifiedBatches(
    _poolAddress: string,
    after: ReplayPosition,
  ): Promise<PersistedMerkleStateBatch[]> {
    let names: string[];
    try {
      names = await readdir(this.journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: PersistedMerkleStateBatch[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const parsed = parseJournal(await readFile(join(this.journalDir, name), "utf8"));
      if (comparePosition(parsed.checkpoint.position, after) > 0) entries.push(parsed);
    }
    entries.sort((a, b) => comparePosition(a.checkpoint.position, b.checkpoint.position));
    return entries;
  }

  async pruneJournalThrough(position: ReplayPosition): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const path = join(this.journalDir, name);
      const entry = parseJournal(await readFile(path, "utf8"));
      if (comparePosition(entry.checkpoint.position, position) <= 0) {
        await rm(path, { force: true });
      }
    }
    await syncDirectory(this.journalDir);
  }
}

export interface PersistentState {
  provider: MerkleStateProvider;
  compact(): Promise<MerkleStateCheckpoint>;
}

export interface PersistentStateOptions {
  client: Client;
  network: Network;
  poolAddress: string;
  kind: "jetton" | "ton";
  poseidon2: Poseidon2;
  rootDir: string;
  lock?: StateLockOptions;
}

function guardedProvider(
  provider: LocalProvider,
  isActive: () => boolean,
  track: <T>(operation: () => Promise<T>) => Promise<T>,
): MerkleStateProvider {
  const assertActive = () => {
    if (!isActive()) {
      throw new Error("verified state provider scope has already been released");
    }
  };
  return {
    get privacyMode() {
      assertActive();
      return provider.privacyMode;
    },
    sync: (target) => track(() => provider.sync(target)),
    checkpoint: () => track(() => provider.checkpoint()),
    insertionPath: (nextIndex) =>
      track(() => provider.insertionPath(nextIndex)),
    membershipPath: (leafIndex) =>
      track(() => provider.membershipPath(leafIndex)),
    sparseSetWitness: (setId, key) =>
      track(() => provider.sparseSetWitness(setId, key)),
  };
}

export async function withPersistentState<T>(
  options: PersistentStateOptions,
  operation: (state: PersistentState) => Promise<T>,
): Promise<T> {
  const poolAddress = Address.parse(options.poolAddress).toString(ADDRESS_FORMAT);
  return withPoolStateLock({
    rootDir: options.rootDir,
    network: options.network,
    poolAddress,
    lock: options.lock,
  }, async () => {
    const store = new FileMerkleStateStore(
      options.rootDir,
      options.network,
      poolAddress,
    );
    const source = options.kind === "jetton"
      ? await Pool.createEventSource(options.client, poolAddress)
      : createClientEventSource(options.client);
    const chain = options.kind === "jetton"
      ? Pool.createStateChainReader(options.client)
      : TonPool.createStateChainReader(options.client);
    const rawProvider = await LocalMerkleStateProvider.create({
      poolAddress,
      poseidon2: options.poseidon2,
      source,
      chain,
      store,
    });

    let active = true;
    const inFlight = new Set<Promise<unknown>>();
    const track = <R>(start: () => Promise<R>): Promise<R> => {
      if (!active) {
        return Promise.reject(
          new Error("verified state provider scope has already been released"),
        );
      }
      let result: Promise<R>;
      try {
        result = Promise.resolve(start());
      } catch (error) {
        return Promise.reject(error);
      }
      inFlight.add(result);
      void result.then(
        () => inFlight.delete(result),
        () => inFlight.delete(result),
      );
      return result;
    };
    const provider = guardedProvider(rawProvider, () => active, track);
    const scoped: PersistentState = {
      provider,
      compact: () => track(async () => {
        if (!await store.needsCompaction()) {
          return rawProvider.checkpoint();
        }
        const checkpoint = await rawProvider.saveCompactSnapshot(
          SNAPSHOT_CHUNK_SIZE,
        );
        await store.pruneJournalThrough(checkpoint.position);
        return checkpoint;
      }),
    };
    try {
      return await operation(scoped);
    } finally {
      active = false;
      await Promise.allSettled([...inFlight]);
    }
  });
}
