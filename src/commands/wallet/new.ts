import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { promises as fs } from "node:fs";
import { ui, colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs } from "../../lib/args.js";
import {
  createAndEncryptMnemonic,
  generateMnemonic,
  mnemonicToWallet,
} from "../../lib/wallet.js";

export default defineCommand({
  meta: {
    name: "new",
    description: "Generate a new 24-word mnemonic and encrypt it under a passphrase.",
  },
  args: {
    ...outputArgs,
    name: {
      type: "string",
      description: "Name of the wallet (prompts if not provided).",
    },
    overwrite: {
      type: "boolean",
      description: "Replace an existing wallet of the same name.",
      default: false,
    },
    "passphrase-file": {
      type: "string",
      description: "Read passphrase from the first line of this file (overrides ZKR_PASSPHRASE env).",
    },
    "reveal-mnemonic": {
      type: "boolean",
      description: "Include the mnemonic in --json output. Off by default (security).",
      default: false,
    },
  },
  async run({ args }) {
    const name = args.name ?? (args.json ? "default" : await promptName());
    const mnemonic = await generateMnemonic();
    const { address } = await mnemonicToWallet(mnemonic);

    if (!args.json) {
      ui.intro("zkr wallet new");
      p.note(
        mnemonic
          .map((w, i) => `${String(i + 1).padStart(2, " ")}. ${w}`)
          .reduce((acc, w, i) => acc + w + ((i + 1) % 4 === 0 ? "\n" : "  "), "")
          .trim(),
        colors.yellow("⚠  Write this down. It is your ONLY backup."),
      );
      const confirmed = await p.confirm({
        message: "I have written down the mnemonic.",
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        throw new CliError("Mnemonic not confirmed. Aborted.", { code: "CANCELLED" });
      }
    }

    const passphrase = await resolvePassphrase({
      file: args["passphrase-file"],
      promptIfMissing: !args.json,
    });

    const { path } = await createAndEncryptMnemonic({
      name,
      mnemonic,
      passphrase,
      overwrite: args.overwrite,
    });

    emit(
      {
        wallet: {
          name,
          address,
          path,
          ...(args["reveal-mnemonic"] ? { mnemonic } : {}),
        },
      },
      args,
      () => {
        p.note(
          `${colors.cyan("Address")}: ${address}\n${colors.cyan("File")}:    ${path}`,
          "Wallet created",
        );
        ui.outro(`Wallet "${name}" ready. Top it up before depositing.`);
      },
    );
  },
});

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
    throw new CliError(
      "Passphrase required.",
      { code: "INVALID_ARG", hint: "Set ZKR_PASSPHRASE env var or use --passphrase-file." },
    );
  }
  const pass = await p.password({
    message: "Choose a passphrase (required for every send).",
    validate: (s) => (s.length < 8 ? "Use at least 8 characters." : undefined),
  });
  if (p.isCancel(pass)) throw new CliError("Cancelled.", { code: "CANCELLED" });
  const confirm = await p.password({ message: "Confirm passphrase." });
  if (p.isCancel(confirm)) throw new CliError("Cancelled.", { code: "CANCELLED" });
  if (pass !== confirm) throw new CliError("Passphrases do not match.", { code: "INVALID_ARG" });
  return pass;
}
