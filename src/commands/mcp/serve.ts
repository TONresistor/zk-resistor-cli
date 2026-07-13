import { defineCommand } from "citty";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Factory,
  Pool,
  TON_POOL_DENOMINATIONS,
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
import { notePoolAsset } from "../../lib/format.js";
import {
  canonicalAddress,
  canonicalRecipientAddress,
  notePoolBinding,
  optionalUint64,
  positiveBigInt,
  sameAddress,
} from "../../lib/validation.js";

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

async function toolResult(operation: () => Promise<unknown>) {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return jsonResult(
      isPendingDepositError(error)
        ? pendingDepositErrorPayload(error)
        : { error: errText(error) },
    );
  }
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
  const server = new McpServer({ name: "zkresistor", version: "2.0.1" });

  server.registerTool(
    "list_pools",
    {
      title: "List ZKResistor pools",
      description:
        "List every deposit pool deployed by the ZKResistor factory, with denomination, anonymity-set size and current Merkle root.",
      inputSchema: { network: networkArg },
      annotations: READ,
    },
    async ({ network }) =>
      toolResult(async () => {
        const { net, sdk } = await sdkFor(network);
        const pools = await Factory.listPools(sdk, net.factoryAddress);
        return { network: net.network, poolCount: pools.length, pools };
      }),
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
    async ({ address, network }) =>
      toolResult(async () => {
        const { net, sdk } = await sdkFor(network);
        const pools = await Factory.listPools(sdk, net.factoryAddress);
        const requestedPool = canonicalAddress(address, "pool address");
        const pool = pools.find((entry) =>
          sameAddress(entry.poolAddress, requestedPool));
        if (!pool) {
          throw new Error(`Pool ${address} not found on ${net.network}.`);
        }
        const state =
          pool.kind === "ton"
            ? await TonPool.readState(sdk, pool.poolAddress)
            : await Pool.readState(sdk, pool.poolAddress);
        return { network: net.network, pool, state };
      }),
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
    async () => toolResult(async () => ({ wallets: await listKeystores() })),
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
    async ({ pool, wallet, network }) =>
      toolResult(async () => {
        const passphrase = requirePassphrase();
        const { net, ton, sdk } = await sdkFor(network);
        const cfg = await loadZkrConfig();
        const pools = await Factory.listPools(sdk, net.factoryAddress);
        const requestedPool = canonicalAddress(pool, "pool address");
        const target = pools.find((entry) =>
          sameAddress(entry.poolAddress, requestedPool));
        if (!target) {
          throw new Error(`Pool ${pool} not found on ${net.network}.`);
        }

        const loaded = await unlockWallet({ name: wallet, passphrase });
        let userJettonWallet: string | undefined;
        if (target.kind === "jetton") {
          if (target.jettonWallet === null) {
            throw new Error("Jetton pool is not ready: its pool wallet is not bound.");
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
            asset: notePoolAsset(target),
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
          journalSecret: loaded.keyPair.secretKey,
          send: () => sendOne(ton, loaded, {
            to: result.message.address,
            value: result.message.value,
            body: result.message.payload,
            bounce: target.kind === "jetton",
          }),
        });
        return {
          ok: true,
          pool: target.poolAddress,
          from: loaded.address,
          note: result.noteString,
          expectedLeafIndex: result.expectedLeafIndex,
          journalPath: submission.journalPath,
          payloadHash: submission.payloadHash,
        };
      }),
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw from a ZKResistor pool",
      description:
        "Withdraw using a secret note, sending the denomination to a recipient. The broadcaster can receive up to the 0.30 GRAM earmark, net of transaction and action costs. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        note: z.string().describe("Secret note from a prior deposit."),
        to: z.string().describe("Recipient address (EQ...)."),
        wallet: z.string().describe("Name of a stored wallet to broadcast from."),
        pool: z
          .string()
          .optional()
          .describe("Optional assertion of the pool address bound to the note."),
        queryId: z
          .string()
          .optional()
          .describe("Optional uint64 client correlation id for this new withdrawal."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ note, to, wallet, pool, queryId, network }) =>
      toolResult(async () => {
        const passphrase = requirePassphrase();
        const parsed = parseNote(note);
        if (!parsed) throw new Error("Invalid note format.");
        const { net, ton, sdk } = await sdkFor(network);
        const cfg = await loadZkrConfig();
        const recipient = canonicalRecipientAddress(to);
        const { poolAddress, kind } = notePoolBinding(parsed, pool);
        const clientQueryId = optionalUint64(queryId);

        const loaded = await unlockWallet({ name: wallet, passphrase });
        const poseidon2 = await loadPoseidon2(cfg.hasherWasm);
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
            recipientAddress: recipient,
            queryId: clientQueryId,
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
        return {
          ok: true,
          pool: poolAddress,
          recipient,
          broadcaster: loaded.address,
          queryId: plan.queryId,
          nullifierHash:
            "0x" + plan.nullifierHash.toString(16).padStart(64, "0"),
        };
      }),
  );

  server.registerTool(
    "create_pool",
    {
      title: "Create a ZKResistor jetton pool",
      description:
        "Start a new Jetton pool creation for a (jetton master, denomination) pair. Sends 0.55 GRAM by default; the protocol minimum is 0.45 GRAM. The result remains pending until wallet binding and Factory activation complete. Requires ZKR_PASSPHRASE in the server environment.",
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
    async ({ jetton, denomination, wallet, network }) =>
      toolResult(async () => {
        const passphrase = requirePassphrase();
        const jettonMaster = canonicalAddress(jetton, "jetton master");
        const denom = positiveBigInt(denomination, "Denomination");
        const { net, ton, sdk } = await sdkFor(network);
        const plan = await planJettonPoolCreation(
          sdk,
          net.factoryAddress,
          jettonMaster,
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
        return {
          ok: true,
          poolAddress: expectedPool,
          jettonMaster,
          denomination: denom,
          deployer: loaded.address,
          status: "broadcast_pending_activation",
        };
      }),
  );

  server.registerTool(
    "activate_pool",
    {
      title: "Activate a ZKResistor Jetton pool",
      description:
        "Trigger or retry a Jetton pool's TEP-89 wallet binding and Factory activation. Sends up to 0.06 GRAM, or 0.02 GRAM for a confirmation retry once bound. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        pool: z.string().describe("Jetton pool address (EQ...)."),
        wallet: z.string().describe("Name of a stored wallet to pay from."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ pool, wallet, network }) =>
      toolResult(async () => {
        const passphrase = requirePassphrase();
        const poolAddress = canonicalAddress(pool, "pool address");
        const { net, ton, sdk } = await sdkFor(network);
        const plan = await planPoolActivation(
          sdk,
          net.factoryAddress,
          poolAddress,
        );
        if (plan.status === "active") {
          return {
            ok: true,
            network: net.network,
            poolAddress,
            status: "already_active",
          };
        }
        if (plan.message === null) {
          throw new Error("Pending Pool activation has no message");
        }
        const msg = plan.message;
        const loaded = await unlockWallet({ name: wallet, passphrase });
        await sendOne(ton, loaded, {
          to: msg.address,
          value: msg.value,
          body: msg.payload,
          bounce: true,
        });
        return {
          ok: true,
          network: net.network,
          poolAddress,
          broadcaster: loaded.address,
          queryId: msg.queryId,
          status: "broadcast",
        };
      }),
  );

  server.registerTool(
    "create_ton_pool",
    {
      title: "Create a ZKResistor GRAM pool",
      description:
        "Start a native GRAM pool creation for a whitelisted denomination (10/100/1000/10000 GRAM). Sends 0.55 GRAM by default; the protocol minimum is 0.45 GRAM. Requires ZKR_PASSPHRASE in the server environment.",
      inputSchema: {
        denomination: z
          .string()
          .describe("Denomination in nanograms (a whitelisted value)."),
        wallet: z.string().describe("Name of a stored wallet to pay from."),
        network: networkArg,
      },
      annotations: WRITE,
    },
    async ({ denomination, wallet, network }) =>
      toolResult(async () => {
        const passphrase = requirePassphrase();
        const denom = positiveBigInt(denomination, "Denomination");
        if (!TON_POOL_DENOMINATIONS.some((allowed) => allowed === denom)) {
          throw new Error(
            `Denomination ${denom} is not allowed. Expected one of: ${TON_POOL_DENOMINATIONS.join(", ")}.`,
          );
        }
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
        return {
          ok: true,
          poolAddress: expectedPool,
          denomination: denom,
          deployer: loaded.address,
          status: "broadcast",
        };
      }),
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
