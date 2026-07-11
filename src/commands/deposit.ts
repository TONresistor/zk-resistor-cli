import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { Address } from "@ton/core";
import { Factory, finalizeDeposit, prepareDeposit } from "@tonresistor/zkresistor-sdk";
import { ui, colors, fmtTon } from "../lib/ui.js";
import { emit, progress } from "../lib/output.js";
import { CliError } from "../lib/errors.js";
import { outputArgs, networkArgs, walletArg, yesArg } from "../lib/args.js";
import { loadZkrConfig } from "../lib/config.js";
import { resolveConfiguredNetwork } from "../lib/network.js";
import { makeSdkClient, makeTonClient, resolveJettonWallet } from "../lib/client.js";
import { sendOne, unlockWallet } from "../lib/wallet.js";
import { loadInsertProver, loadPoseidon2 } from "../lib/prover.js";
import { withPersistentState } from "../lib/state.js";
import { submitPendingDeposit } from "../lib/pending-deposit.js";

export default defineCommand({
  meta: {
    name: "deposit",
    description: "Deposit into a pool. Prints the secret note — back it up immediately.",
  },
  args: {
    ...outputArgs,
    ...networkArgs,
    ...walletArg,
    ...yesArg,
    pool: { type: "string", description: "Pool address (EQ...).", required: true },
  },
  async run({ args }) {
    const net = await resolveConfiguredNetwork(args.net);
    const cfg = await loadZkrConfig();
    const ton = await makeTonClient(net);
    const sdk = makeSdkClient(ton);

    progress("Reading factory…", args);
    const pools = await Factory.listPools(sdk, net.factoryAddress);
    let requestedPool: Address;
    try {
      requestedPool = Address.parse(args.pool);
    } catch {
      throw new CliError(`Invalid pool address: ${args.pool}`, {
        code: "INVALID_ADDRESS",
      });
    }
    const pool = pools.find((x) => Address.parse(x.poolAddress).equals(requestedPool));
    if (!pool) {
      throw new CliError(`Pool ${args.pool} not found.`, {
        code: "POOL_NOT_FOUND",
        details: { factory: net.factoryAddress, pool: args.pool },
      });
    }

    progress(`Unlocking wallet "${args.wallet}"…`, args);
    const loaded = await unlockWallet({ name: args.wallet });

    let userJettonWallet: string | undefined;
    if (pool.kind === "jetton") {
      if (pool.jettonWallet === null) {
        throw new CliError("Jetton pool is not ready: its pool wallet is not bound.", {
          code: "INVALID_ARG",
          hint: "Wait for PoolReady before depositing.",
        });
      }
      progress("Resolving user jetton wallet…", args);
      userJettonWallet = await resolveJettonWallet(ton, pool.jettonMaster, loaded.address);
    }

    if (!args.yes && !args.json) {
      ui.intro("zkr deposit");
      p.note(
        [
          `${colors.cyan("Pool")}:         ${pool.poolAddress}`,
          `${colors.cyan("Asset")}:        ${pool.kind === "ton" ? "TON" : pool.jettonSymbol}`,
          `${colors.cyan("Denomination")}: ${denomLabel(pool)}`,
          `${colors.cyan("From")}:         ${loaded.address}`,
        ].join("\n"),
        "About to deposit",
      );
      const ok = await p.confirm({ message: "Proceed?", initialValue: false });
      if (p.isCancel(ok) || !ok) throw new CliError("Cancelled.", { code: "CANCELLED" });
    }

    progress("Loading verified Merkle state…", args);
    const poseidon2 = await loadPoseidon2(cfg.hasherWasm);
    const result = await withPersistentState({
      client: sdk,
      network: net.network,
      poolAddress: pool.poolAddress,
      kind: pool.kind,
      poseidon2,
      rootDir: cfg.stateDir,
    }, async (persistent) => {
      const prep = await prepareDeposit(sdk, {
        kind: pool.kind,
        poolAddress: pool.poolAddress,
        asset: pool.kind === "ton" ? "TON" : pool.jettonSymbol,
        denomination: pool.denomination,
        userAddress: loaded.address,
        userJettonWallet,
        stateProvider: persistent.provider,
      });

      if (!args.json) {
        p.note(prep.noteString, colors.yellow("⚠  SAVE THIS NOTE NOW"));
      }

      if (!args.yes && !args.json) {
        const saved = await p.confirm({ message: "I have saved the note.", initialValue: false });
        if (p.isCancel(saved) || !saved) {
          throw new CliError("Cancelled. No transaction sent.", { code: "CANCELLED" });
        }
      }

      progress("Generating insert proof (10-30s)…", args);
      const prover = await loadInsertProver({ wasm: cfg.insertWasm, zkey: cfg.insertZkey });
      const plan = await finalizeDeposit(sdk, { prep, poseidon2, insertProver: prover });
      await persistent.compact();
      return {
        message: plan.message,
        noteString: prep.noteString,
        expectedLeafIndex: prep.expectedLeafIndex,
      };
    });

    progress("Securing note and broadcasting…", args);
    const submission = await submitPendingDeposit({
      network: net.network,
      pool: pool.poolAddress,
      wallet: loaded.address,
      expectedLeafIndex: result.expectedLeafIndex,
      target: result.message.address,
      value: result.message.value,
      payload: result.message.payload,
      note: result.noteString,
      send: () => sendOne(ton, loaded, {
        to: result.message.address,
        value: result.message.value,
        body: result.message.payload,
        bounce: pool.kind === "jetton",
      }),
    });

    emit(
      {
        deposit: {
          pool: pool.poolAddress,
          asset: pool.kind === "ton" ? "TON" : pool.jettonSymbol,
          denomination: pool.denomination,
          from: loaded.address,
          note: result.noteString,
          expected_leaf_index: result.expectedLeafIndex,
          journal_path: submission.journalPath,
          payload_hash: submission.payloadHash,
        },
      },
      args,
      () => {
        ui.outro(`Deposited ${denomLabel(pool)} → ${pool.poolAddress.slice(0, 8)}…`);
      },
    );
  },
});

function denomLabel(p: import("@tonresistor/zkresistor-sdk").PoolInfo): string {
  if (p.kind === "ton") return fmtTon(p.denomination);
  const human = p.denomination / 10n ** BigInt(p.jettonDecimals);
  return `${human} ${p.jettonSymbol}`;
}
