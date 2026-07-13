import { defineCommand } from "citty";
import * as p from "../../lib/prompts.js";
import { ui, colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, yesArg } from "../../lib/args.js";
import { decryptKeystore, readKeystore } from "../../lib/keystore.js";
import { resolvePassphrase } from "../../lib/input.js";

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
      message: "Passphrase",
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
