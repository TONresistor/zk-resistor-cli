import { defineCommand } from "citty";
import { homedir } from "node:os";
import { join } from "node:path";
import { Address } from "@ton/core";
import { colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, networkArgs } from "../../lib/args.js";
import { readKeystore } from "../../lib/keystore.js";
import { resolveConfiguredNetwork } from "../../lib/network.js";
import { makeTonClient } from "../../lib/client.js";
import { formatGram } from "../../lib/format.js";

export default defineCommand({
  meta: {
    name: "show",
    description: "Show one wallet's address + on-chain balance.",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    name: {
      type: "positional",
      description: "Wallet name.",
      required: true,
    },
  },
  async run({ args }) {
    const ks = await readKeystore(args.name).catch((e) => {
      if (e instanceof CliError) throw e;
      throw new CliError(`Wallet not found: ${args.name}`, { code: "WALLET_NOT_FOUND" });
    });
    const net = await resolveConfiguredNetwork(args.net);
    const ton = await makeTonClient(net);
    const state = await ton
      .getContractState(Address.parse(ks.address))
      .catch(() => null);
    const balance = state?.balance ?? null;
    const status = state?.state ?? "unknown";

    const keystorePath = join(homedir(), ".config", "zkresistor", "wallets", `${args.name}.json`);

    emit(
      {
        wallet: {
          name: args.name,
          address: ks.address,
          created_at: ks.createdAt,
          path: keystorePath,
          status,
          balance_nano: balance,
          network: net.network,
        },
      },
      args,
      () => {
        const print = (k: string, v: string) =>
          console.log(`  ${colors.cyan(k.padEnd(12))} ${v}`);
        console.log();
        print("Name", args.name);
        print("Address", ks.address);
        print("Status", status);
        print("Balance", balance === null ? colors.dim("(unreachable)") : formatGram(balance));
        print("Network", net.network);
        print("Created", ks.createdAt);
        print("Path", keystorePath);
        console.log();
      },
    );
  },
});
