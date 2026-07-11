import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { Address } from "@ton/core";
import { buildWithdraw, Factory, parseNote } from "@tonresistor/zkresistor-sdk";
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

export default defineCommand({
  meta: {
    name: "withdraw",
    description: "Withdraw from a pool. The broadcaster can receive up to the 0.30 TON earmark, net of costs.",
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
      description: "Pool address. Optional if the note matches exactly one pool.",
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

    try { Address.parse(args.to); }
    catch { throw new CliError(`Invalid recipient: ${args.to}`, { code: "INVALID_ADDRESS" }); }

    const net = await resolveConfiguredNetwork(args.net);
    const queryId = parseOptionalQueryId(args["query-id"]);
    const cfg = await loadZkrConfig();
    const ton = await makeTonClient(net);
    const sdk = makeSdkClient(ton);

    let poolAddress = args.pool ?? note.poolAddress;
    if (!poolAddress) {
      progress("Discovering pool from note…", args);
      const all = await Factory.listPools(sdk, net.factoryAddress);
      const matches = all.filter((pool) => {
        if (note.asset === "TON") return pool.kind === "ton" && pool.denomination === note.denominationUnits;
        return pool.kind === "jetton" && pool.jettonSymbol === note.asset && pool.denomination === note.denominationUnits;
      });
      if (matches.length === 0) {
        throw new CliError(`No pool matches the note.`, {
          code: "POOL_NOT_FOUND",
          details: { asset: note.asset, denomination: note.denominationUnits.toString() },
        });
      }
      if (matches.length > 1) {
        throw new CliError("Multiple pools match this note. Pass --pool.", {
          code: "POOL_AMBIGUOUS",
          details: { matches: matches.map((m) => m.poolAddress) },
        });
      }
      poolAddress = matches[0]!.poolAddress;
    }
    try {
      poolAddress = Address.parse(poolAddress).toString({
        urlSafe: true,
        bounceable: true,
      });
    } catch {
      throw new CliError(`Invalid pool address: ${poolAddress}`, {
        code: "INVALID_ADDRESS",
      });
    }

    const kind: "jetton" | "ton" =
      note.poolKind ?? (note.asset === "TON" ? "ton" : "jetton");

    if (!args.yes && !args.json) {
      ui.intro("zkr withdraw");
      p.note(
        [
          `${colors.cyan("Pool")}:      ${poolAddress}`,
          `${colors.cyan("Asset")}:     ${note.asset}`,
          `${colors.cyan("Recipient")}: ${args.to}`,
          ...(queryId !== undefined ? [`${colors.cyan("Client query id")}: ${queryId}`] : []),
          colors.dim("Broadcaster return: up to the 0.30 TON earmark, net of transaction and action costs."),
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
      poolAddress: poolAddress!,
      kind,
      poseidon2,
      rootDir: cfg.stateDir,
    }, async (persistent) => {
      const prover = await loadWithdrawProver({ wasm: cfg.withdrawWasm, zkey: cfg.withdrawZkey });
      const built = await buildWithdraw(sdk, {
        kind,
        note,
        poolAddress: poolAddress!,
        recipientAddress: args.to,
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
          recipient: args.to,
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

function parseOptionalQueryId(raw: unknown): bigint | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new CliError("Invalid query id.", {
      code: "INVALID_ARG",
      hint: "Pass --query-id as a decimal integer.",
    });
  }
  const queryId = BigInt(raw);
  if (queryId >= 1n << 64n) {
    throw new CliError("Invalid query id.", {
      code: "INVALID_ARG",
      hint: "Client query ids must fit an unsigned 64-bit integer.",
    });
  }
  return queryId;
}

async function resolveNote(flag: unknown, promptIfMissing: boolean): Promise<string> {
  if (typeof flag === "string" && flag.length > 0) return flag.trim();
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
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
