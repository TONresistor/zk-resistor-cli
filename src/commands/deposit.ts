import { defineCommand } from "citty";
import * as p from "../lib/prompts.js";
import { Factory, finalizeDeposit, prepareDeposit } from "@tonresistor/zkresistor-sdk";
import { ui, colors } from "../lib/ui.js";
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
import {
  displayPoolAsset,
  formatPoolDenomination,
  notePoolAsset,
} from "../lib/format.js";
import { canonicalAddress, sameAddress } from "../lib/validation.js";

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
    const requestedPool = canonicalAddress(args.pool, "pool address");
    const pool = pools.find((entry) => sameAddress(entry.poolAddress, requestedPool));
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
          `${colors.cyan("Asset")}:        ${displayPoolAsset(pool)}`,
          `${colors.cyan("Denomination")}: ${formatPoolDenomination(pool)}`,
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
        asset: notePoolAsset(pool),
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
      journalSecret: loaded.keyPair.secretKey,
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
          asset: notePoolAsset(pool),
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
        ui.outro(`Deposited ${formatPoolDenomination(pool)} → ${pool.poolAddress.slice(0, 8)}…`);
      },
    );
  },
});
