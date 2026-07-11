import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { Address } from "@ton/core";
import { ui, colors, fmtTon } from "../../lib/ui.js";
import { emit, progress } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, networkArgs, walletArg, yesArg } from "../../lib/args.js";
import { resolveConfiguredNetwork } from "../../lib/network.js";
import { makeSdkClient, makeTonClient } from "../../lib/client.js";
import { sendOne, unlockWallet } from "../../lib/wallet.js";
import { planJettonPoolCreation } from "../../lib/pool-creation.js";

export default defineCommand({
  meta: {
    name: "create",
    description: "Start a new Jetton pool creation (0.55 TON default; 0.45 TON protocol minimum).",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    ...walletArg,
    ...yesArg,
    jetton: { type: "string", description: "Jetton master address (EQ...).", required: true },
    denom: {
      type: "string",
      description: "Denomination in smallest jetton units (e.g. 1000000000000 for 1000 KITO at 9 decimals).",
      required: true,
    },
  },
  async run({ args }) {
    const net = await resolveConfiguredNetwork(args.net);
    const denomination = BigInt(args.denom);
    if (denomination <= 0n) throw new CliError("Denomination must be positive.", { code: "INVALID_ARG" });

    try { Address.parse(args.jetton); }
    catch { throw new CliError(`Invalid jetton master: ${args.jetton}`, { code: "INVALID_ADDRESS" }); }

    const ton = await makeTonClient(net);
    const sdk = makeSdkClient(ton);

    progress("Checking Factory and computing the deterministic Pool address…", args);
    const plan = await planJettonPoolCreation(
      sdk,
      net.factoryAddress,
      args.jetton,
      denomination,
    );
    const expectedPool = plan.poolAddress;
    const msg = plan.message;

    if (!args.yes && !args.json) {
      ui.intro("zkr pool create");
      p.note(
        [
          `${colors.cyan("Jetton")}:         ${args.jetton}`,
          `${colors.cyan("Denomination")}:   ${denomination.toString()}`,
          `${colors.cyan("Pool address")}:   ${expectedPool}`,
          `${colors.cyan("Cost")}:           ${fmtTon(msg.value)}`,
        ].join("\n"),
        "About to create",
      );
      const ok = await p.confirm({ message: "Proceed?", initialValue: false });
      if (p.isCancel(ok) || !ok) throw new CliError("Cancelled.", { code: "CANCELLED" });
    }

    progress(`Unlocking wallet "${args.wallet}"…`, args);
    const loaded = await unlockWallet({ name: args.wallet });

    progress("Broadcasting CreatePool…", args);
    await sendOne(ton, loaded, { to: msg.address, value: msg.value, body: msg.payload });

    emit(
      {
        pool_create: {
          pool_address: expectedPool,
          jetton_master: args.jetton,
          denomination,
          deployer: loaded.address,
          status: "broadcast_pending_activation",
        },
      },
      args,
      () => ui.outro(`Creation broadcast. Pool activation is pending: ${expectedPool}`),
    );
  },
});
