import { defineCommand } from "citty";
import * as p from "../../lib/prompts.js";
import { ui, colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs } from "../../lib/args.js";
import {
  createAndEncryptMnemonic,
  generateMnemonic,
  mnemonicToWallet,
} from "../../lib/wallet.js";
import { promptWalletName, resolvePassphrase } from "../../lib/input.js";

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
    const name = args.name ?? (args.json ? "default" : await promptWalletName());
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
      message: "Choose a passphrase (required for every send).",
      minLength: 8,
      confirm: true,
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
