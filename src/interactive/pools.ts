import * as p from "../lib/prompts.js";
import { parseNote, type PoolInfo } from "@tonresistor/zkresistor-sdk";
import {
  displayPoolAsset,
  formatPoolDenomination,
} from "../lib/format.js";
import {
  filterPools,
  loadPoolCatalog,
  type PoolCategory,
} from "../lib/pools.js";
import {
  canonicalRecipientAddress,
  sameAddress,
} from "../lib/validation.js";
import type { ExecuteCommand, InteractiveSession } from "./types.js";
import { ensureWallet } from "./wallets.js";

const SEARCH_POOL = "__search_pool__";

export async function browsePools(
  session: InteractiveSession,
  execute: ExecuteCommand,
): Promise<void> {
  p.log.step(`Loading ${session.network} Pools...`);
  const catalog = await loadPoolCatalog(session.network);
  if (catalog.pools.length === 0) {
    p.log.warn("No active Pools found.");
    return;
  }

  const category = await p.select({
    message: "Pool type",
    options: [
      { value: "all", label: "All Pools", hint: `${catalog.pools.length}` },
      {
        value: "ton",
        label: "GRAM Pools",
        hint: `${catalog.pools.filter((pool) => pool.kind === "ton").length}`,
      },
      {
        value: "jetton",
        label: "Jetton Pools",
        hint: `${catalog.pools.filter((pool) => pool.kind === "jetton").length}`,
      },
      { value: "back", label: "Back" },
    ],
  });
  if (p.isCancel(category) || category === "back") return;

  const categoryPools = filterPools(catalog.pools, category as PoolCategory);
  if (categoryPools.length === 0) {
    p.log.warn("No active Pools found in this category.");
    return;
  }
  const pool = await selectPool(categoryPools);
  if (pool === undefined) return;

  showPool(pool);
  while (true) {
    const action = await p.select({
      message: formatPoolDenomination(pool),
      options: [
        { value: "deposit", label: "Deposit" },
        { value: "withdraw", label: "Withdraw" },
        { value: "details", label: "On-chain Details" },
        { value: "address", label: "Print Full Address" },
        { value: "back", label: "Back" },
      ],
    });
    if (p.isCancel(action) || action === "back") return;
    if (action === "address") {
      p.note(pool.poolAddress, "Pool Address");
      continue;
    }
    if (action === "details") {
      await execute(["pools", "info", pool.poolAddress, "--net", session.network]);
      continue;
    }
    if (action === "deposit") {
      const wallet = await ensureWallet(session);
      if (wallet === undefined) return;
      await execute([
        "deposit",
        "--pool",
        pool.poolAddress,
        "--wallet",
        wallet.name,
        "--net",
        session.network,
      ]);
      return;
    }
    if (action === "withdraw") {
      await withdrawFlow(session, execute, pool.poolAddress);
      return;
    }
  }
}

async function selectPool(pools: PoolInfo[]): Promise<PoolInfo | undefined> {
  let visible = pools;
  while (true) {
    const selectedAddress = await p.select({
      message: "Select a Pool",
      options: [
        {
          value: SEARCH_POOL,
          label: "Search Pool",
          hint: "Token, denomination, or address",
        },
        ...visible.map((pool) => ({
          value: pool.poolAddress,
          label: `${formatPoolDenomination(pool)} - ${pool.nextIndex} deposits`,
          hint: pool.poolAddress,
        })),
      ],
      maxItems: 10,
    });
    if (p.isCancel(selectedAddress)) return undefined;
    if (selectedAddress !== SEARCH_POOL) {
      const pool = visible.find((entry) => entry.poolAddress === selectedAddress);
      if (pool === undefined) throw new Error("Selected Pool is no longer available.");
      return pool;
    }

    const query = await p.text({
      message: "Search Pool",
      defaultValue: "",
    });
    if (p.isCancel(query)) return undefined;
    const matches = filterPools(pools, "all", query);
    if (matches.length === 0) {
      p.log.warn("No Pool matches this search.");
      continue;
    }
    visible = matches;
  }
}

export async function withdrawFlow(
  session: InteractiveSession,
  execute: ExecuteCommand,
  assertedPool?: string,
): Promise<void> {
  const wallet = await ensureWallet(session);
  if (wallet === undefined) return;

  const note = await p.password({
    message: "Paste the Secret Note",
    validate: (value) => validateNote(value, assertedPool),
  });
  if (p.isCancel(note)) return;

  const recipient = await p.text({
    message: "Recipient",
    placeholder: wallet.address,
    defaultValue: wallet.address,
    validate: validateRecipient,
  });
  if (p.isCancel(recipient)) return;

  await execute([
    "withdraw",
    "--note",
    note.trim(),
    "--to",
    recipient.trim(),
    ...(assertedPool === undefined ? [] : ["--pool", assertedPool]),
    "--wallet",
    wallet.name,
    "--net",
    session.network,
  ]);
}

function showPool(pool: PoolInfo): void {
  const lines = [
    `Asset:         ${displayPoolAsset(pool)}`,
    `Denomination:  ${formatPoolDenomination(pool)}`,
    `Deposits:      ${pool.nextIndex} / ${pool.capacity}`,
    `Address:       ${pool.poolAddress}`,
    ...(pool.kind === "jetton" ? [`Jetton master: ${pool.jettonMaster}`] : []),
  ];
  p.note(lines.join("\n"), "Active Pool");
}

function validateNote(value: string, assertedPool?: string): string | undefined {
  const note = parseNote(value.trim());
  if (note === null) return "Invalid ZKResistor note.";
  if (assertedPool === undefined) return undefined;
  try {
    return sameAddress(note.poolAddress, assertedPool)
      ? undefined
      : "This note belongs to another Pool.";
  } catch {
    return "The note contains an invalid Pool address.";
  }
}

function validateRecipient(value: string): string | undefined {
  try {
    canonicalRecipientAddress(value.trim());
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid recipient.";
  }
}
