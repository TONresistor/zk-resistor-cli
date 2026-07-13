import * as p from "../lib/prompts.js";
import { resolveConfiguredNetwork } from "../lib/network.js";
import type { InteractiveSession } from "./types.js";
import { chooseWallet } from "./wallets.js";

export async function settingsMenu(session: InteractiveSession): Promise<void> {
  while (true) {
    const action = await p.select({
      message: "Settings",
      options: [
        { value: "network", label: "Network", hint: session.network },
        { value: "wallet", label: "Active Wallet", hint: session.wallet ?? "none" },
        { value: "factory", label: "Factory Address" },
        { value: "back", label: "Back" },
      ],
    });
    if (p.isCancel(action) || action === "back") return;

    if (action === "network") {
      const network = await p.select({
        message: "Network",
        options: [
          { value: "mainnet", label: "Mainnet" },
          { value: "testnet", label: "Testnet" },
        ],
        initialValue: session.network,
      });
      if (!p.isCancel(network)) session.network = network;
      continue;
    }
    if (action === "wallet") {
      const wallet = await chooseWallet(session.wallet);
      if (wallet !== undefined) session.wallet = wallet.name;
      continue;
    }
    const network = await resolveConfiguredNetwork(session.network);
    p.note(network.factoryAddress || "Not configured", `${session.network} Factory`);
  }
}
