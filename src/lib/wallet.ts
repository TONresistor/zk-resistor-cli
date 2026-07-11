/**
 * Wallet operations — bridges the encrypted keystore with @ton/ton's
 * `WalletContractV5R1`.
 *
 * V5R1 is the current TON wallet standard (highload-friendly, signed via
 * Ed25519 from a 24-word BIP-39-ish mnemonic).
 */

import {
  internal,
  SendMode,
  WalletContractV5R1,
  type OpenedContract,
  type Sender,
  TonClient,
} from "@ton/ton";
import { Address, type Cell } from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate } from "@ton/crypto";
import * as p from "@clack/prompts";
import { CliError } from "./errors.js";
import {
  readKeystore,
  decryptKeystore,
  writeKeystore,
  type listKeystores as ListFn,
} from "./keystore.js";

export type OpenedWallet = OpenedContract<WalletContractV5R1>;

export interface LoadedWallet {
  wallet: WalletContractV5R1;
  address: string;
  keyPair: { publicKey: Buffer; secretKey: Buffer };
}

const WORKCHAIN = 0;

export async function generateMnemonic(): Promise<string[]> {
  return mnemonicNew(24);
}

export async function mnemonicToWallet(mnemonic: string[]): Promise<LoadedWallet> {
  if (mnemonic.length !== 24 || !(await mnemonicValidate(mnemonic))) {
    throw new CliError("Invalid mnemonic — expected 24 valid BIP-39 words.");
  }
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV5R1.create({
    workchain: WORKCHAIN,
    publicKey: keyPair.publicKey,
  });
  return {
    wallet,
    address: wallet.address.toString({ urlSafe: true, bounceable: false }),
    keyPair,
  };
}

/** Read keystore + prompt for passphrase + decrypt + parse mnemonic. */
export async function unlockWallet(opts: {
  name: string;
  /** If set, skips the prompt (CI/scripts). Falls back to ZKR_PASSPHRASE env. */
  passphrase?: string;
}): Promise<LoadedWallet> {
  const ks = await readKeystore(opts.name);
  const pass =
    opts.passphrase ??
    process.env.ZKR_PASSPHRASE ??
    (await promptPassphrase(`Passphrase for wallet "${opts.name}"`));
  const mnemonicStr = await decryptKeystore(ks, pass);
  const words = mnemonicStr.trim().split(/\s+/);
  return mnemonicToWallet(words);
}

/** Build a `Sender` bound to a TonClient + key pair for use in @ton/ton flows. */
export function makeSender(
  client: TonClient,
  loaded: LoadedWallet,
): Sender {
  const opened = client.open(loaded.wallet) as OpenedWallet;
  return opened.sender(loaded.keyPair.secretKey);
}

/** Convenience: send a single internal message from the loaded wallet. */
export async function sendOne(
  client: TonClient,
  loaded: LoadedWallet,
  msg: { to: string; value: bigint; body: Cell; bounce?: boolean },
): Promise<void> {
  const opened = client.open(loaded.wallet) as OpenedWallet;
  const seqno = await opened.getSeqno();
  await opened.sendTransfer({
    seqno,
    secretKey: loaded.keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: Address.parse(msg.to),
        value: msg.value,
        body: msg.body,
        bounce: msg.bounce ?? true,
      }),
    ],
  });
}

async function promptPassphrase(label: string): Promise<string> {
  const v = await p.password({
    message: label,
    validate: (s) => (s.length === 0 ? "Passphrase cannot be empty." : undefined),
  });
  if (p.isCancel(v)) throw new CliError("Cancelled.");
  return v;
}

export async function createAndEncryptMnemonic(opts: {
  name: string;
  mnemonic: string[];
  passphrase: string;
  overwrite?: boolean;
}): Promise<{ address: string; path: string }> {
  const loaded = await mnemonicToWallet(opts.mnemonic);
  const path = await writeKeystore({
    name: opts.name,
    address: loaded.address,
    payload: opts.mnemonic.join(" "),
    passphrase: opts.passphrase,
    overwrite: opts.overwrite,
  });
  return { address: loaded.address, path };
}

// Re-export listing helper so commands import from a single place.
export { listKeystores } from "./keystore.js";
export type { ListFn };
