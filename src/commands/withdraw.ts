import { defineCommand } from "citty";
import * as p from "../lib/prompts.js";
import { buildWithdraw, parseNote } from "@tonresistor/zkresistor-sdk";
import { ui, colors } from "../lib/ui.js";
import { emit, progress } from "../lib/output.js";
import { CliError } from "../lib/errors.js";
import { outputArgs, networkArgs, walletArg, yesArg } from "../lib/args.js";
import { loadZkrConfig } from "../lib/config.js";
import { resolveConfiguredNetwork } from "../lib/network.js";
import { makeSdkClient, makeTonClient } from "../lib/client.js";
import { sendOne, unlockWallet } from "../lib/wallet.js";
import { loadPoseidon2, loadWithdrawProver } from "../lib/prover.js";
import { withPersistentState } from "../lib/state.js";
import { readStdin } from "../lib/input.js";
import {
  canonicalRecipientAddress,
  notePoolBinding,
  optionalUint64,
} from "../lib/validation.js";

export default defineCommand({
  meta: {
    name: "withdraw",
    description: "Withdraw from a pool. The broadcaster can receive up to the 0.30 GRAM earmark, net of costs.",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    ...walletArg,
    ...yesArg,
    note: {
      type: "string",
      description: "Secret note from `zkr deposit`. If omitted, reads from stdin (when piped) or prompts.",
    },
    to: {
      type: "string",
      description: "Recipient address (EQ...).",
      required: true,
    },
    pool: {
      type: "string",
      description: "Optional assertion of the pool address bound to the note.",
    },
    "query-id": {
      type: "string",
      description: "Optional uint64 client correlation id for this new withdrawal.",
    },
  },
  async run({ args }) {
    const noteRaw = await resolveNote(args.note, !args.json);
    const note = parseNote(noteRaw);
    if (!note) throw new CliError("Invalid note format.", { code: "INVALID_NOTE" });

    const recipient = canonicalRecipientAddress(args.to);

    const net = await resolveConfiguredNetwork(args.net);
    const queryId = optionalUint64(args["query-id"]);
    const cfg = await loadZkrConfig();
    const ton = await makeTonClient(net);
    const sdk = makeSdkClient(ton);

    const { poolAddress, kind } = notePoolBinding(note, args.pool);

    if (!args.yes && !args.json) {
      ui.intro("zkr withdraw");
      p.note(
        [
          `${colors.cyan("Pool")}:      ${poolAddress}`,
          `${colors.cyan("Asset")}:     ${kind === "ton" ? "GRAM" : note.asset}`,
          `${colors.cyan("Recipient")}: ${recipient}`,
          ...(queryId !== undefined ? [`${colors.cyan("Client query id")}: ${queryId}`] : []),
          colors.dim("Broadcaster return: up to the 0.30 GRAM earmark, net of transaction and action costs."),
        ].join("\n"),
        "About to withdraw",
      );
      const ok = await p.confirm({ message: "Proceed?", initialValue: false });
      if (p.isCancel(ok) || !ok) throw new CliError("Cancelled.", { code: "CANCELLED" });
    }

    progress(`Unlocking wallet "${args.wallet}"…`, args);
    const loaded = await unlockWallet({ name: args.wallet });

    progress("Generating withdraw proof (10-30s)…", args);
    const poseidon2 = await loadPoseidon2(cfg.hasherWasm);
    const plan = await withPersistentState({
      client: sdk,
      network: net.network,
      poolAddress,
      kind,
      poseidon2,
      rootDir: cfg.stateDir,
    }, async (persistent) => {
      const prover = await loadWithdrawProver({ wasm: cfg.withdrawWasm, zkey: cfg.withdrawZkey });
      const built = await buildWithdraw(sdk, {
        kind,
        note,
        poolAddress,
        recipientAddress: recipient,
        queryId,
        stateProvider: persistent.provider,
        poseidon2,
        withdrawProver: prover,
      });
      await persistent.compact();
      return {
        message: built.message,
        nullifierHash: built.nullifierHash,
        queryId: built.queryId,
      };
    });

    progress("Broadcasting…", args);
    await sendOne(ton, loaded, {
      to: plan.message.address,
      value: plan.message.value,
      body: plan.message.payload,
      bounce: true,
    });

    emit(
      {
        withdraw: {
          pool: poolAddress,
          recipient,
          asset: note.asset,
          denomination: note.denominationUnits,
          query_id: plan.queryId,
          nullifier_hash_hex: "0x" + plan.nullifierHash.toString(16).padStart(64, "0"),
          relayer_earmark_nano: 300_000_000,
          broadcaster: loaded.address,
        },
      },
      args,
      () => {
        ui.outro("Withdrawal broadcast.");
      },
    );
  },
});

async function resolveNote(flag: unknown, promptIfMissing: boolean): Promise<string> {
  if (typeof flag === "string" && flag.length > 0) return flag.trim();
  if (!process.stdin.isTTY) {
    const raw = (await readStdin()).trim();
    if (raw) return raw;
  }
  if (!promptIfMissing) {
    throw new CliError("No note provided.", {
      code: "INVALID_ARG",
      hint: "Pass --note <s>, pipe to stdin, or run without --json for an interactive prompt.",
    });
  }
  const v = await p.password({
    message: "Paste your secret note (hidden).",
    validate: (s) => (parseNote(s.trim()) ? undefined : "Not a valid ZKResistor note."),
  });
  if (p.isCancel(v)) throw new CliError("Cancelled.", { code: "CANCELLED" });
  return v.trim();
}
