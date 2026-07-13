import { defineCommand } from "citty";
import { Pool, TonPool } from "@tonresistor/zkresistor-sdk";
import { colors } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, networkArgs } from "../../lib/args.js";
import { formatGram, formatPoolDenomination } from "../../lib/format.js";
import { canonicalAddress, sameAddress } from "../../lib/validation.js";
import { loadPoolCatalog } from "../../lib/pools.js";

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
    const requestedPool = canonicalAddress(args.address, "pool address");

    progress("Loading factory + pool…", args);
    const catalog = await loadPoolCatalog(args.net);
    const match = catalog.pools.find((pool) => sameAddress(pool.poolAddress, requestedPool));
    if (!match) {
      throw new CliError(`Pool ${args.address} not in factory ${catalog.network.factoryAddress}`, {
        code: "POOL_NOT_FOUND",
      });
    }
    const state =
      match.kind === "ton"
        ? await TonPool.readState(catalog.client, match.poolAddress)
        : await Pool.readState(catalog.client, match.poolAddress);
    const rootHex = "0x" + state.currentRoot.toString(16).padStart(64, "0");

    const out: Record<string, unknown> = {
      network: catalog.network.network,
      address: match.poolAddress,
      kind: match.kind,
      denomination: match.denomination,
      anonymity_set: state.nextIndex,
      capacity: match.capacity,
      current_root_hex: rootHex,
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
      print("Denomination", formatPoolDenomination(match));
      print("Anonymity set", `${state.nextIndex} / ${match.capacity}`);
      print("Current root", rootHex);
      if (match.kind === "jetton") {
        print("Jetton master", match.jettonMaster);
        print("Jetton wallet", match.jettonWallet ?? colors.red("(unset)"));
      } else {
        print("Total locked", formatGram(match.pendingWithdrawTon));
      }
      console.log();
    });
  },
});
