import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { promises as fs } from "node:fs";
import { ui, colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, yesArg } from "../../lib/args.js";
import { decryptKeystore, readKeystore } from "../../lib/keystore.js";

export default defineCommand({
  meta: {
    name: "export-mnemonic",
    description: "Decrypt and print the wallet mnemonic. Requires --yes to acknowledge.",
  },
  args: {
    ...outputArgs,
    ...yesArg,
    name: {
      type: "positional",
      description: "Wallet name.",
      required: true,
    },
    "passphrase-file": {
      type: "string",
      description: "Read passphrase from this file (overrides ZKR_PASSPHRASE).",
    },
  },
  async run({ args }) {
    const ks = await readKeystore(args.name);

    if (!args.yes && !args.json) {
      ui.intro(colors.yellow("zkr wallet export-mnemonic"));
      const ok = await p.confirm({
        message: "Anyone with the mnemonic can spend the wallet. Continue?",
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) throw new CliError("Cancelled.", { code: "CANCELLED" });
    }

    const passphrase = await resolvePassphrase({
      file: args["passphrase-file"],
      promptIfMissing: !args.json,
    });

    const mnemonic = await decryptKeystore(ks, passphrase);
    const words = mnemonic.trim().split(/\s+/);

    emit(
      { mnemonic: words, address: ks.address },
      args,
      () => {
        p.note(
          words
            .map((w, i) => `${String(i + 1).padStart(2, " ")}. ${w}`)
            .reduce((acc, w, i) => acc + w + ((i + 1) % 4 === 0 ? "\n" : "  "), "")
            .trim(),
          colors.yellow(`Mnemonic for ${args.name}`),
        );
        ui.outro("Keep it secret. Anyone with this string can spend the wallet.");
      },
    );
  },
});

async function resolvePassphrase(opts: {
  file?: string;
  promptIfMissing: boolean;
}): Promise<string> {
  if (opts.file) {
    const raw = await fs.readFile(opts.file, "utf8").catch(() => {
      throw new CliError(`Passphrase file not readable: ${opts.file}`, { code: "INVALID_ARG" });
    });
    return raw.split(/\r?\n/)[0] ?? "";
  }
  if (process.env.ZKR_PASSPHRASE) return process.env.ZKR_PASSPHRASE;
  if (!opts.promptIfMissing) {
    throw new CliError("Passphrase required.", {
      code: "INVALID_ARG",
      hint: "Set ZKR_PASSPHRASE env var or use --passphrase-file.",
    });
  }
  const v = await p.password({
    message: "Passphrase",
    validate: (s) => (s.length === 0 ? "Cannot be empty." : undefined),
  });
  if (p.isCancel(v)) throw new CliError("Cancelled.", { code: "CANCELLED" });
  return v;
}
