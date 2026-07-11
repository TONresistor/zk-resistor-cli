import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { promises as fs } from "node:fs";
import { ui, colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs } from "../../lib/args.js";
import { createAndEncryptMnemonic } from "../../lib/wallet.js";
import { mnemonicValidate } from "@ton/crypto";

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
    // Citty captures all remaining positional args in `args._` (single-positional
    // declarations only capture the first one). Use `_` for variadic mnemonics.
    const positionals = (args as unknown as { _?: string[] })._ ?? [];
    const words = await resolveMnemonic({
      cliWords: positionals,
      file: args["mnemonic-file"],
      promptIfMissing: !args.json,
    });
    if (words.length !== 24 || !(await mnemonicValidate(words))) {
      throw new CliError("Invalid mnemonic — expected 24 valid BIP-39 words.", {
        code: "INVALID_MNEMONIC",
      });
    }

    const name = args.name ?? (args.json ? "default" : await promptName());
    const passphrase = await resolvePassphrase({
      file: args["passphrase-file"],
      promptIfMissing: !args.json,
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
  // 1. Positional words on CLI
  if (opts.cliWords.length === 24) {
    return opts.cliWords.map(String);
  }
  if (opts.cliWords.length > 0 && opts.cliWords.length !== 24) {
    // Partial — clearly the user intended positionals but miscounted.
    throw new CliError(
      `Expected 24 mnemonic words, got ${opts.cliWords.length}.`,
      { code: "INVALID_MNEMONIC" },
    );
  }
  // 2. File
  if (opts.file) {
    const raw = await fs.readFile(opts.file, "utf8").catch(() => {
      throw new CliError(`Mnemonic file not readable: ${opts.file}`, { code: "INVALID_ARG" });
    });
    return raw.trim().split(/\s+/);
  }
  // 3. Piped stdin (non-TTY)
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw) return raw.split(/\s+/);
  }
  // 4. Interactive
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

async function promptName(): Promise<string> {
  const v = await p.text({
    message: "Wallet name",
    initialValue: "default",
    validate: (s) =>
      /^[a-zA-Z0-9_-]{1,32}$/.test(s) ? undefined : "1-32 alphanumerics, dashes, or underscores.",
  });
  if (p.isCancel(v)) throw new CliError("Cancelled.", { code: "CANCELLED" });
  return v;
}

async function resolvePassphrase(opts: {
  file?: string;
  promptIfMissing: boolean;
}): Promise<string> {
  if (opts.file) {
    const raw = await fs.readFile(opts.file, "utf8").catch(() => {
      throw new CliError(`Passphrase file not readable: ${opts.file}`, { code: "INVALID_ARG" });
    });
    const line = raw.split(/\r?\n/)[0] ?? "";
    if (line.length < 8) {
      throw new CliError("Passphrase file content too short (need ≥ 8 chars).", { code: "INVALID_ARG" });
    }
    return line;
  }
  if (process.env.ZKR_PASSPHRASE) return process.env.ZKR_PASSPHRASE;
  if (!opts.promptIfMissing) {
    throw new CliError("Passphrase required.", {
      code: "INVALID_ARG",
      hint: "Set ZKR_PASSPHRASE env var or use --passphrase-file.",
    });
  }
  const pass = await p.password({
    message: "Passphrase to encrypt the keystore.",
    validate: (s) => (s.length < 8 ? "Use at least 8 characters." : undefined),
  });
  if (p.isCancel(pass)) throw new CliError("Cancelled.", { code: "CANCELLED" });
  return pass;
}
