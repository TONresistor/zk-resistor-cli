import { defineCommand } from "citty";
import { Address } from "@ton/core";
import { Pool, TonPool, Factory } from "@tonresistor/zkresistor-sdk";
import { colors, fmtTon } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, networkArgs } from "../../lib/args.js";
import { resolveConfiguredNetwork } from "../../lib/network.js";
import { makeSdkClient, makeTonClient } from "../../lib/client.js";

export default defineCommand({
  meta: {
    name: "info",
    description: "Show on-chain state of one pool.",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    address: {
      type: "positional",
      description: "Pool address (EQ...).",
      required: true,
    },
  },
  async run({ args }) {
    try {
      Address.parse(args.address);
    } catch {
      throw new CliError(`Invalid TON address: ${args.address}`, { code: "INVALID_ADDRESS" });
    }

    const net = await resolveConfiguredNetwork(args.net);
    const sdk = makeSdkClient(await makeTonClient(net));

    progress("Loading factory + pool…", args);
    const all = await Factory.listPools(sdk, net.factoryAddress);
    const match = all.find((p) => p.poolAddress === args.address);
    if (!match) {
      throw new CliError(`Pool ${args.address} not in factory ${net.factoryAddress}`, {
        code: "POOL_NOT_FOUND",
      });
    }

    const state =
      match.kind === "ton"
        ? await TonPool.readState(sdk, match.poolAddress)
        : await Pool.readState(sdk, match.poolAddress);

    const out: Record<string, unknown> = {
      network: net.network,
      address: match.poolAddress,
      kind: match.kind,
      denomination: match.denomination,
      anonymity_set: state.nextIndex,
      capacity: match.capacity,
      current_root_hex: "0x" + state.currentRoot.toString(16).padStart(64, "0"),
    };
    if (match.kind === "jetton") {
      out.jetton_master = match.jettonMaster;
      out.jetton_wallet = match.jettonWallet;
      out.jetton_symbol = match.jettonSymbol;
      out.jetton_decimals = match.jettonDecimals;
    } else {
      out.locked_ton_nano = match.pendingWithdrawTon;
    }

    emit({ pool: out }, args, () => {
      const print = (k: string, v: string) =>
        console.log(`  ${colors.cyan(k.padEnd(16))} ${v}`);
      console.log();
      print("Address", match.poolAddress);
      print("Kind", match.kind);
      print("Denomination", denomLabel(match));
      print("Anonymity set", `${state.nextIndex} / ${match.capacity}`);
      print("Current root", out.current_root_hex as string);
      if (match.kind === "jetton") {
        print("Jetton master", match.jettonMaster);
        print("Jetton wallet", match.jettonWallet ?? colors.red("(unset)"));
      } else {
        print("Total locked", fmtTon(match.pendingWithdrawTon));
      }
      console.log();
    });
  },
});

function denomLabel(p: import("@tonresistor/zkresistor-sdk").PoolInfo): string {
  if (p.kind === "ton") return fmtTon(p.denomination);
  const human = p.denomination / 10n ** BigInt(p.jettonDecimals);
  return `${human} ${p.jettonSymbol}`;
}
