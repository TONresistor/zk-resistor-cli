import { defineCommand } from "citty";
import * as p from "../../lib/prompts.js";
import { ui, colors } from "../../lib/ui.js";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs, yesArg } from "../../lib/args.js";
import { deleteKeystore, readKeystore } from "../../lib/keystore.js";

export default defineCommand({
  meta: {
    name: "remove",
    description: "Remove a wallet from local storage. Irreversible without the mnemonic.",
  },
  args: {
    ...outputArgs,
    ...yesArg,
    name: {
      type: "positional",
      description: "Wallet name.",
      required: true,
    },
  },
  async run({ args }) {
    const ks = await readKeystore(args.name);

    if (!args.yes && !args.json) {
      ui.intro(colors.red("zkr wallet remove"));
      const ok = await p.confirm({
        message: `Permanently remove "${args.name}" (${ks.address})?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) throw new CliError("Cancelled.", { code: "CANCELLED" });
    }

    await deleteKeystore(args.name);

    emit(
      { removed: { name: args.name, address: ks.address } },
      args,
      () => {
        ui.outro(`Removed "${args.name}".`);
      },
    );
  },
});
