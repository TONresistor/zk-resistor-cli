import { defineCommand } from "citty";
import { Factory, type PoolInfo } from "@tonresistor/zkresistor-sdk";
import { colors, fmtTon, shortAddr } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { outputArgs, networkArgs } from "../../lib/args.js";
import { resolveConfiguredNetwork } from "../../lib/network.js";
import { makeSdkClient, makeTonClient } from "../../lib/client.js";

export default defineCommand({
  meta: {
    name: "list",
    description: "List all deployed pools (jetton + TON).",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
  },
  async run({ args }) {
    const net = await resolveConfiguredNetwork(args.net);
    progress(`Reading factory ${shortAddr(net.factoryAddress)}…`, args);
    const sdk = makeSdkClient(await makeTonClient(net));
    const pools = await Factory.listPools(sdk, net.factoryAddress);

    emit(
      {
        network: net.network,
        factory: net.factoryAddress,
        pool_count: pools.length,
        pools: pools.map(toJson),
      },
      args,
      () => prettyList(pools),
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

function prettyList(pools: PoolInfo[]): void {
  if (pools.length === 0) {
    console.log(colors.dim("\n  No pools deployed.\n"));
    return;
  }
  console.log();
  for (const pool of pools) {
    const head =
      pool.kind === "ton"
        ? `${colors.cyan("TON".padEnd(8))} ${fmtTon(pool.denomination).padEnd(14)}`
        : `${colors.cyan(pool.jettonSymbol.padEnd(8))} ${(pool.denomination / 10n ** BigInt(pool.jettonDecimals)).toString().padEnd(14)}`;
    const deposits = `${pool.nextIndex.toString().padStart(4)} deposits`;
    const locked =
      pool.kind === "ton"
        ? fmtTon(pool.pendingWithdrawTon)
        : colors.dim("(off-chain jetton balance)");
    console.log(`  ${head}  ${colors.dim(shortAddr(pool.poolAddress))}  ${deposits}  ${locked}`);
  }
  console.log();
}
