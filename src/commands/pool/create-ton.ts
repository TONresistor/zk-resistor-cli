import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { TON_POOL_DENOMINATIONS } from "@tonresistor/zkresistor-sdk";
import { ui, colors, fmtTon } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, networkArgs, walletArg, yesArg } from "../../lib/args.js";
import { resolveConfiguredNetwork } from "../../lib/network.js";
import { makeSdkClient, makeTonClient } from "../../lib/client.js";
import { sendOne, unlockWallet } from "../../lib/wallet.js";
import { planTonPoolCreation } from "../../lib/pool-creation.js";

export default defineCommand({
  meta: {
    name: "create-ton",
    description: "Start a native TON pool creation (0.55 TON default; 0.45 TON protocol minimum).",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    ...walletArg,
    ...yesArg,
    denom: { type: "string", description: "Denomination in nanoTON.", required: true },
  },
  async run({ args }) {
    const net = await resolveConfiguredNetwork(args.net);
    const denomination = BigInt(args.denom);
    if (!TON_POOL_DENOMINATIONS.includes(denomination as never)) {
      throw new CliError(
        `Denomination ${denomination} not in whitelist.`,
        {
          code: "INVALID_ARG",
          hint: `Allowed: ${TON_POOL_DENOMINATIONS.join(", ")}`,
        },
      );
    }

    const ton = await makeTonClient(net);
    const sdk = makeSdkClient(ton);
    progress("Checking Factory and computing the deterministic TonPool address…", args);
    const plan = await planTonPoolCreation(sdk, net.factoryAddress, denomination);
    const expectedPool = plan.poolAddress;
    const msg = plan.message;

    if (!args.yes && !args.json) {
      ui.intro("zkr pool create-ton");
      p.note(
        [
          `${colors.cyan("Denomination")}: ${fmtTon(denomination)}`,
          `${colors.cyan("Pool address")}: ${expectedPool}`,
          `${colors.cyan("Cost")}:         ${fmtTon(msg.value)}`,
        ].join("\n"),
        "About to create TonPool",
      );
      const ok = await p.confirm({ message: "Proceed?", initialValue: false });
      if (p.isCancel(ok) || !ok) throw new CliError("Cancelled.", { code: "CANCELLED" });
    }

    progress(`Unlocking wallet "${args.wallet}"…`, args);
    const loaded = await unlockWallet({ name: args.wallet });

    progress("Broadcasting CreateTonPool…", args);
    await sendOne(ton, loaded, { to: msg.address, value: msg.value, body: msg.payload });

    emit(
      {
        pool_create_ton: {
          pool_address: expectedPool,
          denomination_nano: denomination,
          deployer: loaded.address,
          status: "broadcast",
        },
      },
      args,
      () => ui.outro(`TonPool creation broadcast: ${expectedPool}`),
    );
  },
});
