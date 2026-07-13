import { defineCommand } from "citty";
import * as p from "../../lib/prompts.js";
import { readFile } from "node:fs/promises";
import { ui, colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs } from "../../lib/args.js";
import { createAndEncryptMnemonic } from "../../lib/wallet.js";
import { mnemonicValidate } from "@ton/crypto";
import {
  promptWalletName,
  readStdin,
  resolvePassphrase,
} from "../../lib/input.js";

export default defineCommand({
  meta: {
    name: "import",
    description: "Import an existing 24-word mnemonic and encrypt it.",
  },
  args: {
    ...outputArgs,
    name: {
      type: "string",
      description: "Name of the wallet (prompts if not provided).",
    },
    overwrite: {
      type: "boolean",
      description: "Replace an existing wallet.",
      default: false,
    },
    "mnemonic-file": {
      type: "string",
      description: "Read the 24-word mnemonic from this file (whitespace-separated).",
    },
    "passphrase-file": {
      type: "string",
      description: "Read passphrase from the first line of this file (overrides ZKR_PASSPHRASE env).",
    },
  },
  async run({ args }) {
    const positionals = args._;
    const words = await resolveMnemonic({
      cliWords: positionals,
      file: args["mnemonic-file"],
      promptIfMissing: !args.json,
    });
    if (words.length !== 24 || !(await mnemonicValidate(words))) {
      throw new CliError("Invalid mnemonic — expected 24 valid TON mnemonic words.", {
        code: "INVALID_MNEMONIC",
      });
    }

    const name = args.name ?? (args.json ? "default" : await promptWalletName());
    const passphrase = await resolvePassphrase({
      file: args["passphrase-file"],
      promptIfMissing: !args.json,
      message: "Passphrase to encrypt the keystore.",
      minLength: 8,
    });

    const { address, path } = await createAndEncryptMnemonic({
      name,
      mnemonic: words,
      passphrase,
      overwrite: args.overwrite,
    });

    emit(
      { wallet: { name, address, path } },
      args,
      () => {
        ui.intro("zkr wallet import");
        p.note(
          `${colors.cyan("Address")}: ${address}\n${colors.cyan("File")}:    ${path}`,
          "Imported",
        );
        ui.outro(`Wallet "${name}" ready.`);
      },
    );
  },
});

async function resolveMnemonic(opts: {
  cliWords: string[];
  file?: string;
  promptIfMissing: boolean;
}): Promise<string[]> {
  if (opts.cliWords.length === 24) {
    return opts.cliWords.map(String);
  }
  if (opts.cliWords.length > 0 && opts.cliWords.length !== 24) {
    throw new CliError(
      `Expected 24 mnemonic words, got ${opts.cliWords.length}.`,
      { code: "INVALID_MNEMONIC" },
    );
  }
  if (opts.file) {
    const raw = await readFile(opts.file, "utf8").catch(() => {
      throw new CliError(`Mnemonic file not readable: ${opts.file}`, {
        code: "INVALID_ARG",
      });
    });
    return raw.trim().split(/\s+/);
  }
  if (!process.stdin.isTTY) {
    const raw = (await readStdin()).trim();
    if (raw) return raw.split(/\s+/);
  }
  if (!opts.promptIfMissing) {
    throw new CliError("No mnemonic provided.", {
      code: "INVALID_ARG",
      hint: "Pass 24 words as positionals, use --mnemonic-file, or pipe to stdin.",
    });
  }
  const v = await p.password({
    message: "Paste your 24-word mnemonic (hidden).",
    validate: (s) => {
      const w = s.trim().split(/\s+/);
      return w.length === 24 ? undefined : `Expected 24 words, got ${w.length}.`;
    },
  });
  if (p.isCancel(v)) throw new CliError("Cancelled.", { code: "CANCELLED" });
  return v.trim().split(/\s+/);
}
