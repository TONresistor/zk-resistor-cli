import * as p from "../lib/prompts.js";
import { listKeystores } from "../lib/keystore.js";
import {
  isValidWalletName,
  WALLET_NAME_REQUIREMENT,
} from "../lib/validation.js";
import type {
  ExecuteCommand,
  InteractiveSession,
  StoredWallet,
} from "./types.js";

export async function walletMenu(
  session: InteractiveSession,
  execute: ExecuteCommand,
): Promise<void> {
  while (true) {
    const action = await p.select({
      message: "Local Wallets",
      options: [
        { value: "select", label: "Select Active Wallet" },
        { value: "new", label: "Create Wallet" },
        { value: "import", label: "Import Wallet" },
        { value: "show", label: "Show Wallet" },
        { value: "list", label: "List Wallets" },
        { value: "recover", label: "Recover Deposit Notes" },
        { value: "export", label: "Export Mnemonic" },
        { value: "remove", label: "Remove Wallet" },
        { value: "back", label: "Back" },
      ],
    });
    if (p.isCancel(action) || action === "back") return;

    if (action === "new" || action === "import") {
      const name = await promptWalletName();
      if (name === undefined) continue;
      await execute(["wallet", action, "--name", name]);
      session.wallet = name;
      continue;
    }

    if (action === "list") {
      await execute(["wallet", "list", "--net", session.network]);
      continue;
    }

    const wallet = await chooseWallet(session.wallet);
    if (wallet === undefined) continue;

    if (action === "select") {
      session.wallet = wallet.name;
      p.log.success(`Active wallet: ${wallet.name}`);
      continue;
    }
    if (action === "show") {
      await execute(["wallet", "show", wallet.name, "--net", session.network]);
      continue;
    }
    if (action === "recover") {
      await execute(["deposits", "recover", "--wallet", wallet.name]);
      continue;
    }
    if (action === "export") {
      await execute(["wallet", "export-mnemonic", wallet.name]);
      continue;
    }
    if (action === "remove") {
      await execute(["wallet", "remove", wallet.name]);
      if (session.wallet === wallet.name) session.wallet = undefined;
    }
  }
}

export async function ensureWallet(
  session: InteractiveSession,
): Promise<StoredWallet | undefined> {
  const wallets = await listKeystores();
  if (wallets.length === 0) {
    p.log.warn("No local wallet. Create or import one from the Wallets menu.");
    return undefined;
  }
  const selected = wallets.find((wallet) => wallet.name === session.wallet);
  if (selected !== undefined) return selected;
  const wallet = await chooseWallet();
  if (wallet !== undefined) session.wallet = wallet.name;
  return wallet;
}

export async function chooseWallet(active?: string): Promise<StoredWallet | undefined> {
  const wallets = await listKeystores();
  if (wallets.length === 0) {
    p.log.warn("No local wallets stored.");
    return undefined;
  }
  const selected = await p.select({
    message: "Wallet",
    options: wallets.map((wallet) => ({
      value: wallet.name,
      label: wallet.name,
      hint: wallet.address,
    })),
    ...(wallets.some((wallet) => wallet.name === active) ? { initialValue: active } : {}),
    maxItems: 10,
  });
  if (p.isCancel(selected)) return undefined;
  return wallets.find((wallet) => wallet.name === selected);
}

async function promptWalletName(): Promise<string | undefined> {
  const name = await p.text({
    message: "Wallet name",
    placeholder: "default",
    validate: (value) => isValidWalletName(value.trim()) ? undefined : WALLET_NAME_REQUIREMENT,
  });
  return p.isCancel(name) ? undefined : name.trim();
}
