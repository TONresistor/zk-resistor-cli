import { TonClient, type TonClientParameters } from "@ton/ton";
import {
  Address,
  beginCell,
  Cell,
  type TransactionDescription,
  type TupleItem,
} from "@ton/core";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import type {
  AccountState,
  Client as SdkClient,
  GetTransactionsResult,
  RunMethodArg,
  RunMethodResult,
  StackEntry,
  TransactionCursor,
} from "@tonresistor/zkresistor-sdk";
import { CliError } from "./errors.js";
import type { NetworkConfig } from "./network.js";

const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 200;

export async function makeTonClient(net: NetworkConfig): Promise<TonClient> {
  const endpoint =
    process.env.ZKR_RPC_ENDPOINT ??
    (await getHttpEndpoint({ network: net.tonAccessNetwork }));
  const params: TonClientParameters = { endpoint };
  if (process.env.ZKR_RPC_API_KEY) params.apiKey = process.env.ZKR_RPC_API_KEY;
  return new TonClient(params);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;
      if (i < RETRY_ATTEMPTS - 1) {
        const delay = RETRY_BASE_MS * Math.pow(2.5, i);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /status code 50[234]/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up/i.test(msg) ||
    /Request failed with status code 4(08|29)/i.test(msg) ||
    /Network Error/i.test(msg)
  );
}

function wrapNetworkError(e: unknown): never {
  const ae = e as { code?: string; message?: string; response?: { status?: number } };
  const parts = [
    ae.code && `code=${ae.code}`,
    ae.response?.status !== undefined && `status=${ae.response.status}`,
    ae.message,
  ].filter(Boolean);
  const detail = parts.length > 0 ? parts.join(" ") : "unknown error";
  throw new CliError(`RPC request failed: ${detail}`, {
    code: "NETWORK_ERROR",
    hint:
      "The selected public TON endpoint is unavailable. Retry or set ZKR_RPC_ENDPOINT to another compatible endpoint.",
  });
}

export function makeSdkClient(ton: TonClient): SdkClient {
  return {
    async getAccountState(address: string): Promise<AccountState> {
      try {
        const state = await withRetry(() => ton.getContractState(Address.parse(address)));
        return {
          status: state.state,
          data: state.data ? state.data.toString("base64") : undefined,
          code: state.code ? state.code.toString("base64") : undefined,
          balance: state.balance.toString(),
        };
      } catch (e) {
        wrapNetworkError(e);
      }
    },
    async runMethod(
      address: string,
      method: string,
      params: readonly RunMethodArg[],
    ): Promise<RunMethodResult> {
      const tupleParams: TupleItem[] = params.map(toTupleItem);
      try {
        const res = await withRetry(() =>
          ton.runMethod(Address.parse(address), method, tupleParams),
        );
        const stack: StackEntry[] = [];
        const reader = res.stack;
        while (reader.remaining > 0) {
          stack.push(readStackEntry(reader));
        }
        return { exit_code: 0, stack };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = msg.match(/exit_code:\s*(-?\d+)/);
        const exitCode = m?.[1];
        if (exitCode !== undefined) {
          return { exit_code: parseInt(exitCode, 10), stack: [] };
        }
        wrapNetworkError(e);
      }
    },
    async getTransactions(
      address: string,
      limit: number,
      before: TransactionCursor | undefined,
    ): Promise<GetTransactionsResult> {
      try {
        const txs = await withRetry(() =>
          ton.getTransactions(Address.parse(address), {
            limit,
            archival: true,
            ...(before === undefined ? {} : { lt: before.lt, hash: before.hash }),
          }),
        );
        return {
          transactions: txs.map((t) => {
            const out_msgs = [...t.outMessages].map(([index, message]) => ({
              body: message.body.toBoc().toString("base64"),
              index,
              isExternal: message.info.type === "external-out",
            }));
            const inbound = t.inMessage;
            const in_msg = inbound === undefined || inbound === null
              ? undefined
              : {
                  body: inbound.body.toBoc().toString("base64"),
                  ...(inbound.info.type === "internal"
                    ? {
                        source: inbound.info.src.toString({
                          urlSafe: true,
                          bounceable: true,
                        }),
                        bounced: inbound.info.bounced,
                      }
                    : {}),
                };
            return {
              lt: t.lt.toString(),
              hash: t.hash().toString("base64"),
              block_seqno: 0,
              success: transactionSucceeded(t.description),
              ...(in_msg === undefined ? {} : { in_msg }),
              out_msgs,
            };
          }),
          incomplete: txs.length > 0,
        };
      } catch (e) {
        wrapNetworkError(e);
      }
    },
  };
}

export function transactionSucceeded(description: TransactionDescription): boolean {
  switch (description.type) {
    case "generic":
    case "tick-tock":
    case "split-prepare":
    case "merge-install":
      return !description.aborted &&
        description.computePhase.type === "vm" &&
        description.computePhase.success &&
        (description.actionPhase?.success ?? true);
    case "storage":
      return true;
    case "split-install":
      return description.installed;
    case "merge-prepare":
      return !description.aborted;
  }
}

export async function resolveJettonWallet(
  ton: TonClient,
  jettonMaster: string,
  owner: string,
): Promise<string> {
  const arg = beginCell().storeAddress(Address.parse(owner)).endCell();
  const r = await ton.runMethod(Address.parse(jettonMaster), "get_wallet_address", [
    { type: "slice", cell: arg },
  ]);
  return r.stack.readAddress().toString({ urlSafe: true, bounceable: true });
}

function toTupleItem(arg: RunMethodArg): TupleItem {
  if (typeof arg === "string") {
    return { type: "int", value: BigInt(arg) };
  }
  if (arg.type === "slice") {
    return { type: "slice", cell: Cell.fromBase64(arg.boc) };
  }
  throw new Error(`Unsupported RunMethodArg: ${JSON.stringify(arg)}`);
}

function readStackEntry(reader: {
  remaining: number;
  peek: () => TupleItem;
  pop: () => TupleItem;
}): StackEntry {
  const item = reader.pop();
  switch (item.type) {
    case "int":
      return item.value.toString();
    case "cell":
    case "slice":
    case "builder":
      return item.cell.toBoc().toString("base64");
    case "null":
      return null;
    default:
      throw new Error(`Unsupported stack entry type: ${item.type}`);
  }
}
