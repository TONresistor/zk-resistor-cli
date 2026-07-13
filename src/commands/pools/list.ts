import { defineCommand } from "citty";
import type { PoolInfo } from "@tonresistor/zkresistor-sdk";
import { colors } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { outputArgs, networkArgs } from "../../lib/args.js";
import {
  displayPoolAsset,
  formatGram,
  formatPoolAmount,
  shortAddress,
} from "../../lib/format.js";
import { loadPoolCatalog } from "../../lib/pools.js";

export default defineCommand({
  meta: {
    name: "list",
    description: "List all deployed pools (Jetton and GRAM).",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    compact: {
      type: "boolean",
      description: "Use a compact one-line display with shortened addresses.",
      default: false,
    },
  },
  async run({ args }) {
    progress("Reading factory Pools…", args);
    const catalog = await loadPoolCatalog(args.net);

    emit(
      {
        network: catalog.network.network,
        factory: catalog.network.factoryAddress,
        pool_count: catalog.pools.length,
        pools: catalog.pools.map(toJson),
      },
      args,
      () => prettyList(catalog.pools, args.compact),
    );
  },
});

function toJson(p: PoolInfo): Record<string, unknown> {
  const base = {
    kind: p.kind,
    address: p.poolAddress,
    denomination: p.denomination,
    anonymity_set: p.nextIndex,
    capacity: p.capacity,
    current_root_hex: "0x" + p.currentRoot.toString(16).padStart(64, "0"),
  };
  if (p.kind === "ton") {
    return { ...base, locked_ton_nano: p.pendingWithdrawTon };
  }
  return {
    ...base,
    jetton_master: p.jettonMaster,
    jetton_wallet: p.jettonWallet,
    jetton_symbol: p.jettonSymbol,
    jetton_decimals: p.jettonDecimals,
    jetton_name: p.jettonName,
    jetton_image: p.jettonImage,
  };
}

function prettyList(pools: PoolInfo[], compact: boolean): void {
  if (pools.length === 0) {
    console.log(colors.dim("\n  No pools deployed.\n"));
    return;
  }
  console.log();
  for (const pool of pools) {
    const head = `${colors.cyan(displayPoolAsset(pool).padEnd(8))} ${formatPoolAmount(pool).padEnd(14)}`;
    const deposits = `${pool.nextIndex.toString().padStart(4)} deposits`;
    const locked =
      pool.kind === "ton"
        ? formatGram(pool.pendingWithdrawTon)
        : colors.dim("(off-chain jetton balance)");
    if (compact) {
      console.log(`  ${head}  ${colors.dim(shortAddress(pool.poolAddress))}  ${deposits}  ${locked}`);
      continue;
    }
    console.log(`  ${head}  ${deposits}  ${locked}`);
    console.log(`  ${pool.poolAddress}`);
    console.log();
  }
}
