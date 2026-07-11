import { defineCommand } from "citty";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Address } from "@ton/core";
import {
  Factory,
  Pool,
  TonPool,
  buildWithdraw,
  finalizeDeposit,
  parseNote,
  prepareDeposit,
} from "@tonresistor/zkresistor-sdk";
import { resolveConfiguredNetwork, type Network } from "../../lib/network.js";
import {
  makeSdkClient,
  makeTonClient,
  resolveJettonWallet,
} from "../../lib/client.js";
import { sendOne, unlockWallet } from "../../lib/wallet.js";
import { listKeystores } from "../../lib/keystore.js";
import { loadZkrConfig } from "../../lib/config.js";
import {
  loadInsertProver,
  loadPoseidon2,
  loadWithdrawProver,
} from "../../lib/prover.js";
import { withPersistentState } from "../../lib/state.js";
import {
  isPendingDepositError,
  pendingDepositErrorPayload,
  submitPendingDeposit,
} from "../../lib/pending-deposit.js";
import { planPoolActivation } from "../../lib/pool-activation.js";
import {
  planJettonPoolCreation,
  planTonPoolCreation,
} from "../../lib/pool-creation.js";

const networkArg = z.enum(["mainnet", "testnet"]).optional();
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { destructiveHint: true, openWorldHint: true };

function jsonResult(value: unknown) {
  const text = JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
  return { content: [{ type: "text" as const, text }] };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function sdkFor(network: Network | undefined) {
  const net = await resolveConfiguredNetwork(network);
  const ton = await makeTonClient(net);
  return { net, ton, sdk: makeSdkClient(ton) };
}

function requirePassphrase(): string {
  const pass = process.env.ZKR_PASSPHRASE;
  if (!pass) {
    throw new Error(
      "ZKR_PASSPHRASE is not set. The MCP server unlocks wallets non-interactively; " +
        "set ZKR_PASSPHRASE in the server environment to enable deposit, withdraw, create and activate.",
    );
  }
  return pass;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "zkresistor", version: "2.0.0" });

  server.registerTool(
    "list_pools",
    {
      title: "List ZKResistor pools",
      description:
        "List every deposit pool deployed by the ZKResistor factory, with denomination, anonymity-set size and current Merkle root.",
      inputSchema: { network: networkArg },
      annotations: READ,
    },
    async ({ network }) => {
      try {
        const { net, sdk } = await sdkFor(network);
        const pools = await Factory.listPools(sdk, net.factoryAddress);
        return jsonResult({ network: net.network, poolCount: pools.length, pools });
      } catch (e) {
        return jsonResult({ error: errText(e) });
      }
    },
  );

  server.registerTool(
    "pool_info",
    {
      title: "ZKResistor pool info",
      description:
        "Read the on-chain state of one pool: denomination, anonymity set, current root, jetton metadata.",
      inputSchema: {
        address: z.string().describe("Pool address (EQ...)."),
        network: networkArg,
      },
      annotations: READ,
    },
    async ({ address, network }) => {
      try {
        const { net, sdk } = await sdkFor(network);
        const pools = await Factory.listPools(sdk, net.factoryAddress);
        const pool = pools.find((x) => x.poolAddress === address);
        if (!pool) {
          return jsonResult({ error: `Pool ${address} not found on ${net.network}.` });
        }
        const state =
          pool.kind === "ton"
            ? await TonPool.readState(sdk, pool.poolAddress)
            : await Pool.readState(sdk, pool.poolAddress);
        return jsonResult({ network: net.network, pool, state });
      } catch (e) {
        return jsonResult({ error: errText(e) });
      }
    },
  );

  server.registerTool(
    "list_wallets",
    {
      title: "List ZKResistor wallets",
      description:
        "List locally stored wallet names and their public addresses. No secrets are returned.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      try {
        return jsonResult({ wallets: await listKeystores() });
      } catch (e) {
        return jsonResult({ error: errText(e) });
      }
    },
  );

  server.registerTool(
    "deposit",
    {
      title: "Deposit into a ZKResistor pool",
      description:
        "Deposit the pool's fixed denomination and broadcast the transaction. Returns the secret note, the ONLY way to withdraw later. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        pool: z.string().describe("Pool address (EQ...)."),
        wallet: z.string().describe("Name of a stored wallet to pay from."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ pool, wallet, network }) => {
      try {
        const passphrase = requirePassphrase();
        const { net, ton, sdk } = await sdkFor(network);
        const cfg = await loadZkrConfig();
        const pools = await Factory.listPools(sdk, net.factoryAddress);
        const requestedPool = Address.parse(pool);
        const target = pools.find((x) =>
          Address.parse(x.poolAddress).equals(requestedPool));
        if (!target) {
          return jsonResult({ error: `Pool ${pool} not found on ${net.network}.` });
        }

        const loaded = await unlockWallet({ name: wallet, passphrase });
        let userJettonWallet: string | undefined;
        if (target.kind === "jetton") {
          if (target.jettonWallet === null) {
            return jsonResult({
              error: "Jetton pool is not ready: its pool wallet is not bound.",
            });
          }
          userJettonWallet = await resolveJettonWallet(
            ton,
            target.jettonMaster,
            loaded.address,
          );
        }

        const poseidon2 = await loadPoseidon2(cfg.hasherWasm);
        const result = await withPersistentState({
          client: sdk,
          network: net.network,
          poolAddress: target.poolAddress,
          kind: target.kind,
          poseidon2,
          rootDir: cfg.stateDir,
        }, async (persistent) => {
          const prep = await prepareDeposit(sdk, {
            kind: target.kind,
            poolAddress: target.poolAddress,
            asset: target.kind === "ton" ? "TON" : target.jettonSymbol,
            denomination: target.denomination,
            userAddress: loaded.address,
            userJettonWallet,
            stateProvider: persistent.provider,
          });
          const insertProver = await loadInsertProver({
            wasm: cfg.insertWasm,
            zkey: cfg.insertZkey,
          });
          const plan = await finalizeDeposit(sdk, { prep, poseidon2, insertProver });
          await persistent.compact();
          return {
            message: plan.message,
            noteString: plan.noteString,
            expectedLeafIndex: prep.expectedLeafIndex,
          };
        });
        const submission = await submitPendingDeposit({
          network: net.network,
          pool: target.poolAddress,
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
            bounce: target.kind === "jetton",
          }),
        });
        return jsonResult({
          ok: true,
          pool: target.poolAddress,
          from: loaded.address,
          note: result.noteString,
          expectedLeafIndex: result.expectedLeafIndex,
          journalPath: submission.journalPath,
          payloadHash: submission.payloadHash,
        });
      } catch (e) {
        if (isPendingDepositError(e)) {
          return jsonResult(pendingDepositErrorPayload(e));
        }
        return jsonResult({ error: errText(e) });
      }
    },
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw from a ZKResistor pool",
      description:
        "Withdraw using a secret note, sending the denomination to a recipient. The broadcaster can receive up to the 0.30 TON earmark, net of transaction and action costs. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        note: z.string().describe("Secret note from a prior deposit."),
        to: z.string().describe("Recipient address (EQ...)."),
        wallet: z.string().describe("Name of a stored wallet to broadcast from."),
        pool: z
          .string()
          .optional()
          .describe("Pool address. Auto-resolved from the note when omitted."),
        queryId: z
          .string()
          .optional()
          .describe("Optional uint64 client correlation id for this new withdrawal."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ note, to, wallet, pool, queryId, network }) => {
      try {
        const passphrase = requirePassphrase();
        const parsed = parseNote(note);
        if (!parsed) return jsonResult({ error: "Invalid note format." });
        const { net, ton, sdk } = await sdkFor(network);
        const cfg = await loadZkrConfig();

        let poolAddress = pool ?? parsed.poolAddress;
        if (!poolAddress) {
          const all = await Factory.listPools(sdk, net.factoryAddress);
          const matches = all.filter((x) =>
            parsed.asset === "TON"
              ? x.kind === "ton" && x.denomination === parsed.denominationUnits
              : x.kind === "jetton" &&
                x.jettonSymbol === parsed.asset &&
                x.denomination === parsed.denominationUnits,
          );
          if (matches.length !== 1) {
            return jsonResult({
              error:
                matches.length === 0
                  ? "No pool matches the note."
                  : "Multiple pools match the note; pass 'pool' explicitly.",
            });
          }
          poolAddress = matches[0]!.poolAddress;
        }
        poolAddress = Address.parse(poolAddress).toString({
          urlSafe: true,
          bounceable: true,
        });

        const loaded = await unlockWallet({ name: wallet, passphrase });
        const poseidon2 = await loadPoseidon2(cfg.hasherWasm);
        const kind = parsed.poolKind ?? (parsed.asset === "TON" ? "ton" : "jetton");
        const plan = await withPersistentState({
          client: sdk,
          network: net.network,
          poolAddress,
          kind,
          poseidon2,
          rootDir: cfg.stateDir,
        }, async (persistent) => {
          const withdrawProver = await loadWithdrawProver({
            wasm: cfg.withdrawWasm,
            zkey: cfg.withdrawZkey,
          });
          const built = await buildWithdraw(sdk, {
            kind,
            note: parsed,
            poolAddress,
            recipientAddress: to,
            queryId: queryId ? BigInt(queryId) : undefined,
            stateProvider: persistent.provider,
            poseidon2,
            withdrawProver,
          });
          await persistent.compact();
          return {
            message: built.message,
            queryId: built.queryId,
            nullifierHash: built.nullifierHash,
          };
        });
        await sendOne(ton, loaded, {
          to: plan.message.address,
          value: plan.message.value,
          body: plan.message.payload,
          bounce: true,
        });
        return jsonResult({
          ok: true,
          pool: poolAddress,
          recipient: to,
          broadcaster: loaded.address,
          queryId: plan.queryId,
          nullifierHash:
            "0x" + plan.nullifierHash.toString(16).padStart(64, "0"),
        });
      } catch (e) {
        return jsonResult({ error: errText(e) });
      }
    },
  );

  server.registerTool(
    "create_pool",
    {
      title: "Create a ZKResistor jetton pool",
      description:
        "Start a new Jetton pool creation for a (jetton master, denomination) pair. Sends 0.55 TON by default; the protocol minimum is 0.45 TON. The result remains pending until wallet binding and Factory activation complete. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        jetton: z.string().describe("Jetton master address (EQ...)."),
        denomination: z
          .string()
          .describe("Denomination in smallest jetton units."),
        wallet: z.string().describe("Name of a stored wallet to pay from."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ jetton, denomination, wallet, network }) => {
      try {
        const passphrase = requirePassphrase();
        const denom = BigInt(denomination);
        const { net, ton, sdk } = await sdkFor(network);
        const plan = await planJettonPoolCreation(
          sdk,
          net.factoryAddress,
          jetton,
          denom,
        );
        const expectedPool = plan.poolAddress;
        const msg = plan.message;
        const loaded = await unlockWallet({ name: wallet, passphrase });
        await sendOne(ton, loaded, {
          to: msg.address,
          value: msg.value,
          body: msg.payload,
        });
        return jsonResult({
          ok: true,
          poolAddress: expectedPool,
          jettonMaster: jetton,
          denomination: denom,
          deployer: loaded.address,
          status: "broadcast_pending_activation",
        });
      } catch (e) {
        return jsonResult({ error: errText(e) });
      }
    },
  );

  server.registerTool(
    "activate_pool",
    {
      title: "Activate a ZKResistor Jetton pool",
      description:
        "Trigger or retry a Jetton pool's TEP-89 wallet binding and Factory activation. Sends up to 0.06 TON, or 0.02 TON for a confirmation retry once bound. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        pool: z.string().describe("Jetton pool address (EQ...)."),
        wallet: z.string().describe("Name of a stored wallet to pay from."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ pool, wallet, network }) => {
      try {
        const passphrase = requirePassphrase();
        const poolAddress = Address.parse(pool).toString({
          urlSafe: true,
          bounceable: true,
        });
        const { net, ton, sdk } = await sdkFor(network);
        const plan = await planPoolActivation(
          sdk,
          net.factoryAddress,
          poolAddress,
        );
        if (plan.status === "active") {
          return jsonResult({
            ok: true,
            network: net.network,
            poolAddress,
            status: "already_active",
          });
        }
        const msg = plan.message!;
        const loaded = await unlockWallet({ name: wallet, passphrase });
        await sendOne(ton, loaded, {
          to: msg.address,
          value: msg.value,
          body: msg.payload,
          bounce: true,
        });
        return jsonResult({
          ok: true,
          network: net.network,
          poolAddress,
          broadcaster: loaded.address,
          queryId: msg.queryId,
          status: "broadcast",
        });
      } catch (e) {
        return jsonResult({ error: errText(e) });
      }
    },
  );

  server.registerTool(
    "create_ton_pool",
    {
      title: "Create a ZKResistor TON pool",
      description:
        "Start a native-TON pool creation for a whitelisted denomination (10/100/1000/10000 TON). Sends 0.55 TON by default; the protocol minimum is 0.45 TON. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        denomination: z
          .string()
          .describe("Denomination in nanoTON (a whitelisted value)."),
        wallet: z.string().describe("Name of a stored wallet to pay from."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ denomination, wallet, network }) => {
      try {
        const passphrase = requirePassphrase();
        const denom = BigInt(denomination);
        const { net, ton, sdk } = await sdkFor(network);
        const plan = await planTonPoolCreation(sdk, net.factoryAddress, denom);
        const expectedPool = plan.poolAddress;
        const msg = plan.message;
        const loaded = await unlockWallet({ name: wallet, passphrase });
        await sendOne(ton, loaded, {
          to: msg.address,
          value: msg.value,
          body: msg.payload,
        });
        return jsonResult({
          ok: true,
          poolAddress: expectedPool,
          denomination: denom,
          deployer: loaded.address,
          status: "broadcast",
        });
      } catch (e) {
        return jsonResult({ error: errText(e) });
      }
    },
  );

  return server;
}

export default defineCommand({
  meta: {
    name: "serve",
    description:
      "Start the MCP stdio server. Exposes ZKResistor pool, deposit, withdraw and create tools to AI agents.",
  },
  async run() {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    await new Promise<void>(() => {});
  },
});
