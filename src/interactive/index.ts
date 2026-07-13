import * as p from "../lib/prompts.js";
import { CliError } from "../lib/errors.js";
import { listKeystores } from "../lib/keystore.js";
import { resolveConfiguredNetwork } from "../lib/network.js";
import { createPoolMenu } from "./create-pool.js";
import { browsePools, withdrawFlow } from "./pools.js";
import { settingsMenu } from "./settings.js";
import type { ExecuteCommand, InteractiveSession } from "./types.js";
import { walletMenu } from "./wallets.js";

interface InteractiveOptions {
  execute: ExecuteCommand;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const network = await resolveConfiguredNetwork(undefined);
  const wallets = await listKeystores();
  const preferred = wallets.find((wallet) => wallet.name === "default") ?? wallets[0];
  const session: InteractiveSession = {
    network: network.network,
    ...(preferred === undefined ? {} : { wallet: preferred.name }),
  };

  p.intro("ZKResistor CLI 2.0.1");
  while (true) {
    const action = await p.select({
      message: "Select an action",
      options: [
        { value: "pools", label: "Browse Pools", hint: "Deposit, withdraw, inspect" },
        { value: "withdraw", label: "Withdraw a Secret Note" },
        { value: "create", label: "Create a Pool" },
        { value: "wallets", label: "Wallets" },
        { value: "settings", label: "Settings" },
        { value: "exit", label: "Exit" },
      ],
    });

    if (p.isCancel(action) || action === "exit") {
      p.outro("Session closed.");
      return;
    }

    try {
      if (action === "pools") await browsePools(session, options.execute);
      if (action === "withdraw") await withdrawFlow(session, options.execute);
      if (action === "create") await createPoolMenu(session, options.execute);
      if (action === "wallets") await walletMenu(session, options.execute);
      if (action === "settings") await settingsMenu(session);
    } catch (error) {
      reportError(error);
    }
  }
}

function reportError(error: unknown): void {
  if (error instanceof CliError) {
    if (error.code === "CANCELLED") {
      p.log.warn("Cancelled.");
      return;
    }
    p.log.error(error.message);
    if (error.hint !== undefined) p.log.info(error.hint);
    return;
  }
  p.log.error(error instanceof Error ? error.message : String(error));
}
