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
import { CliError } from "./errors.js";
import {
  readKeystore,
  decryptKeystore,
  writeKeystore,
} from "./keystore.js";
import { resolvePassphrase } from "./input.js";

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
    throw new CliError("Invalid mnemonic — expected 24 valid TON mnemonic words.");
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

export async function unlockWallet(opts: {
  name: string;
  passphrase?: string;
}): Promise<LoadedWallet> {
  const ks = await readKeystore(opts.name);
  const pass =
    opts.passphrase ??
    await resolvePassphrase({
      promptIfMissing: true,
      message: `Passphrase for wallet "${opts.name}"`,
    });
  const mnemonicStr = await decryptKeystore(ks, pass);
  const words = mnemonicStr.trim().split(/\s+/);
  return mnemonicToWallet(words);
}

export function makeSender(
  client: TonClient,
  loaded: LoadedWallet,
): Sender {
  const opened = client.open(loaded.wallet) as OpenedWallet;
  return opened.sender(loaded.keyPair.secretKey);
}

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

export { listKeystores } from "./keystore.js";
