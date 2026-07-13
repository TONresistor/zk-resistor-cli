import * as p from "./prompts.js";
import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";
import {
  isValidWalletName,
  WALLET_NAME_REQUIREMENT,
} from "./validation.js";

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function promptWalletName(): Promise<string> {
  const value = await p.text({
    message: "Wallet name",
    initialValue: "default",
    validate: (input) =>
      isValidWalletName(input)
        ? undefined
        : WALLET_NAME_REQUIREMENT,
  });
  if (p.isCancel(value)) throw cancelled();
  return value;
}

export async function resolvePassphrase(options: {
  file?: string;
  promptIfMissing: boolean;
  message: string;
  minLength?: number;
  confirm?: boolean;
}): Promise<string> {
  const minLength = options.minLength ?? 1;
  if (options.file) {
    let raw: string;
    try {
      raw = await readFile(options.file, "utf8");
    } catch {
      throw new CliError(`Passphrase file not readable: ${options.file}`, {
        code: "INVALID_ARG",
      });
    }
    const passphrase = raw.split(/\r?\n/)[0] ?? "";
    assertPassphraseLength(passphrase, minLength);
    return passphrase;
  }

  const environment = process.env.ZKR_PASSPHRASE;
  if (environment !== undefined) {
    assertPassphraseLength(environment, minLength);
    return environment;
  }
  if (!options.promptIfMissing) {
    throw new CliError("Passphrase required.", {
      code: "INVALID_ARG",
      hint: "Set ZKR_PASSPHRASE or use --passphrase-file.",
    });
  }

  const passphrase = await p.password({
    message: options.message,
    validate: (input) => passphraseLengthError(input, minLength),
  });
  if (p.isCancel(passphrase)) throw cancelled();
  if (options.confirm) {
    const confirmation = await p.password({ message: "Confirm passphrase." });
    if (p.isCancel(confirmation)) throw cancelled();
    if (passphrase !== confirmation) {
      throw new CliError("Passphrases do not match.", { code: "INVALID_ARG" });
    }
  }
  return passphrase;
}

function cancelled(): CliError {
  return new CliError("Cancelled.", { code: "CANCELLED" });
}

function assertPassphraseLength(value: string, minLength: number): void {
  const message = passphraseLengthError(value, minLength);
  if (message) throw new CliError(message, { code: "INVALID_ARG" });
}

function passphraseLengthError(value: string, minLength: number): string | undefined {
  if (value.length >= minLength) return undefined;
  return minLength === 1
    ? "Passphrase cannot be empty."
    : `Passphrase must contain at least ${minLength} characters.`;
}
