import { defineCommand } from "citty";
import { outputArgs, walletArg } from "../../lib/args.js";
import { CliError } from "../../lib/errors.js";
import { emit, progress } from "../../lib/output.js";
import { recoverPendingDepositJournals } from "../../lib/pending-deposit.js";
import { colors, ui } from "../../lib/ui.js";
import { unlockWallet } from "../../lib/wallet.js";

export default defineCommand({
  meta: {
    name: "recover",
    description: "Decrypt deposit notes protected by a local wallet.",
  },
  args: {
    ...outputArgs,
    ...walletArg,
  },
  async run({ args }) {
    progress(`Unlocking wallet "${args.wallet}"…`, args);
    const loaded = await unlockWallet({ name: args.wallet });
    const recovered = await recoverPendingDepositJournals({
      wallet: loaded.address,
      journalSecret: loaded.keyPair.secretKey,
    });
    if (recovered.journals.length === 0) {
      throw new CliError("No deposit journals found for this wallet.", {
        code: "CLI_ERROR",
        ...(recovered.warnings.length === 0 ? {} : { details: { warnings: recovered.warnings } }),
      });
    }
    const deposits = recovered.journals.map(({ path, entry }) => ({
      network: entry.network,
      pool: entry.pool,
      note: entry.note,
      phase: entry.phase,
      prepared_at: entry.timestamps.preparedAt,
      submitted_at: entry.timestamps.submittedAt,
      journal_path: path,
    }));
    emit({ deposits, warnings: recovered.warnings }, args, () => {
      ui.log.warn("Recovered Secret Notes:");
      for (const deposit of deposits) {
        ui.note(
          [
            `${colors.cyan("Pool")}:    ${deposit.pool}`,
            `${colors.cyan("Status")}:  ${deposit.phase}`,
            `${colors.cyan("Note")}:    ${deposit.note}`,
          ].join("\n"),
          deposit.network,
        );
      }
      for (const warning of recovered.warnings) {
        ui.log.warn(`${warning.path}: ${warning.message}`);
      }
    });
  },
});
