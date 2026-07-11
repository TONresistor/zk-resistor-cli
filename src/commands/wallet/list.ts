import { defineCommand } from "citty";
import { Address } from "@ton/core";
import { ui, colors, fmtTon } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, networkArgs } from "../../lib/args.js";
import { listKeystores } from "../../lib/keystore.js";
import { resolveConfiguredNetwork } from "../../lib/network.js";
import { makeTonClient } from "../../lib/client.js";

export default defineCommand({
  meta: {
    name: "list",
    description: "List stored wallets.",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    balance: {
      type: "boolean",
      alias: "b",
      description: "Fetch on-chain balance for each wallet.",
      default: false,
    },
  },
  async run({ args }) {
    const wallets = await listKeystores();
    if (wallets.length === 0) {
      throw new CliError("No wallets stored.", {
        code: "WALLET_NOT_FOUND",
        hint: "Create one with `zkr wallet new`.",
      });
    }

    const net = await resolveConfiguredNetwork(args.net);
    let withBalances: { name: string; address: string; balance: bigint | null }[];
    if (args.balance) {
      const ton = await makeTonClient(net);
      progress(`Fetching balances on ${net.network}…`, args);
      withBalances = await Promise.all(
        wallets.map(async (w) => {
          try {
            const state = await ton.getContractState(Address.parse(w.address));
            return { ...w, balance: state.balance };
          } catch {
            return { ...w, balance: null };
          }
        }),
      );
    } else {
      withBalances = wallets.map((w) => ({ ...w, balance: null }));
    }

    emit(
      {
        network: net.network,
        wallets: withBalances.map((w) => ({
          name: w.name,
          address: w.address,
          balance_nano: w.balance,
        })),
      },
      args,
      () => {
        ui.log.info(`Stored wallets (${net.network}):`);
        console.log();
        for (const w of withBalances) {
          const bal = w.balance === null ? colors.dim("—") : fmtTon(w.balance);
          console.log(`  ${colors.cyan(w.name.padEnd(10))} ${w.address}  ${colors.dim("·")}  ${bal}`);
        }
        console.log();
      },
    );
  },
});
