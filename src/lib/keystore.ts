import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { CONFIG_DIR } from "./config.js";
import { CliError } from "./errors.js";
import { isValidWalletName, WALLET_NAME_HINT } from "./validation.js";

const KEYSTORE_VERSION = 1 as const;
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

interface KeystoreV1 {
  version: 1;
  address: string;
  createdAt: string;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; saltB64: string };
  cipher: "aes-256-gcm";
  cipherParams: { ivB64: string };
  ciphertextB64: string;
  authTagB64: string;
}

function walletsDir(): string {
  return join(CONFIG_DIR, "wallets");
}

function walletPath(name: string): string {
  if (!isValidWalletName(name)) {
    throw new CliError(`Invalid wallet name "${name}"`, {
      code: "INVALID_ARG",
      hint: WALLET_NAME_HINT,
    });
  }
  return join(walletsDir(), `${name}.json`);
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
}

export async function writeKeystore(opts: {
  name: string;
  address: string;
  payload: string;
  passphrase: string;
  overwrite?: boolean;
}): Promise<string> {
  await fs.mkdir(walletsDir(), { recursive: true, mode: 0o700 });
  const path = walletPath(opts.name);

  if (!opts.overwrite) {
    try {
      await fs.access(path);
      throw new CliError(`Wallet "${opts.name}" already exists at ${path}`, {
        code: "WALLET_ALREADY_EXISTS",
        hint: "Choose another name or pass --overwrite to replace it.",
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(opts.passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(opts.payload, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const out: KeystoreV1 = {
    version: KEYSTORE_VERSION,
    address: opts.address,
    createdAt: new Date().toISOString(),
    kdf: "scrypt",
    kdfParams: {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      saltB64: salt.toString("base64"),
    },
    cipher: "aes-256-gcm",
    cipherParams: { ivB64: iv.toString("base64") },
    ciphertextB64: ciphertext.toString("base64"),
    authTagB64: authTag.toString("base64"),
  };

  await fs.writeFile(path, JSON.stringify(out, null, 2), { mode: 0o600 });
  return path;
}

export async function readKeystore(name: string): Promise<KeystoreV1> {
  const path = walletPath(name);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`No wallet named "${name}"`, {
        code: "WALLET_NOT_FOUND",
        hint: `Run \`zkr wallet new --name ${name}\` first.`,
      });
    }
    throw e;
  }
  const parsed = JSON.parse(raw) as KeystoreV1;
  if (parsed.version !== KEYSTORE_VERSION) {
    throw new CliError(
      `Unsupported keystore version: ${parsed.version} (expected ${KEYSTORE_VERSION})`,
      { code: "CLI_ERROR" },
    );
  }
  return parsed;
}

export async function decryptKeystore(
  ks: KeystoreV1,
  passphrase: string,
): Promise<string> {
  const salt = Buffer.from(ks.kdfParams.saltB64, "base64");
  const iv = Buffer.from(ks.cipherParams.ivB64, "base64");
  const ciphertext = Buffer.from(ks.ciphertextB64, "base64");
  const authTag = Buffer.from(ks.authTagB64, "base64");
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new CliError("Decryption failed — wrong passphrase or corrupted file.", {
      code: "DECRYPT_FAILED",
    });
  }
}

export async function listKeystores(): Promise<{ name: string; address: string }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(walletsDir());
  } catch {
    return [];
  }
  const out: { name: string; address: string }[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -5);
    try {
      const ks = await readKeystore(name);
      out.push({ name, address: ks.address });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteKeystore(name: string): Promise<void> {
  await fs.unlink(walletPath(name));
}
