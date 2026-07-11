import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { Address } from "@ton/core";
import { ui, colors, fmtTon } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, networkArgs, walletArg, yesArg } from "../../lib/args.js";
import { resolveConfiguredNetwork } from "../../lib/network.js";
import { makeSdkClient, makeTonClient } from "../../lib/client.js";
import { planPoolActivation } from "../../lib/pool-activation.js";
import { sendOne, unlockWallet } from "../../lib/wallet.js";

export default defineCommand({
  meta: {
    name: "activate",
    description: "Trigger or retry a Jetton pool's wallet binding and Factory activation.",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    ...walletArg,
    ...yesArg,
    address: {
      type: "positional",
      description: "Jetton pool address (EQ...).",
      required: true,
    },
  },
  async run({ args }) {
    let poolAddress: string;
    try {
      poolAddress = Address.parse(args.address).toString({
        urlSafe: true,
        bounceable: true,
      });
    } catch {
      throw new CliError(`Invalid pool address: ${args.address}`, {
        code: "INVALID_ADDRESS",
      });
    }

    const net = await resolveConfiguredNetwork(args.net);
    const ton = await makeTonClient(net);
    progress("Checking Factory registration and activation state…", args);
    const plan = await planPoolActivation(
      makeSdkClient(ton),
      net.factoryAddress,
      poolAddress,
    );
    if (plan.status === "active") {
      emit(
        {
          pool_activation: {
            pool_address: poolAddress,
            status: "already_active",
          },
        },
        args,
        () => ui.outro(`Pool is already active: ${poolAddress}`),
      );
      return;
    }
    const msg = plan.message!;

    if (!args.yes && !args.json) {
      ui.intro("zkr pool activate");
      p.note(
        [
          `${colors.cyan("Pool")}: ${poolAddress}`,
          `${colors.cyan("Cost")}: ${fmtTon(msg.value)}`,
          `${colors.cyan("Wallet bound")}: ${plan.walletBound ? "yes" : "no"}`,
        ].join("\n"),
        "About to trigger activation",
      );
      const ok = await p.confirm({ message: "Proceed?", initialValue: false });
      if (p.isCancel(ok) || !ok) {
        throw new CliError("Cancelled.", { code: "CANCELLED" });
      }
    }

    progress(`Unlocking wallet "${args.wallet}"…`, args);
    const loaded = await unlockWallet({ name: args.wallet });
    progress("Broadcasting InitWalletBinding…", args);
    await sendOne(ton, loaded, {
      to: msg.address,
      value: msg.value,
      body: msg.payload,
      bounce: true,
    });

    emit(
      {
        pool_activation: {
          pool_address: poolAddress,
          broadcaster: loaded.address,
          query_id: msg.queryId,
          status: "broadcast",
        },
      },
      args,
      () => ui.outro(`Activation trigger broadcast: ${poolAddress}`),
    );
  },
});
