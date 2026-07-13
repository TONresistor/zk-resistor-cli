import { Address, beginCell, Dictionary } from "@ton/core";
import type { TonClient } from "@ton/ton";
import { describe, expect, it, vi } from "vitest";
import { makeSdkClient, transactionSucceeded } from "../src/lib/client.js";

const ADDRESS = Address.parseRaw(`0:${"11".repeat(32)}`);

function genericDescription(options: {
  aborted?: boolean;
  computeSuccess?: boolean;
  actionSuccess?: boolean;
}) {
  return {
    type: "generic" as const,
    creditFirst: false,
    computePhase: {
      type: "vm" as const,
      success: options.computeSuccess ?? true,
      messageStateUsed: false,
      accountActivated: false,
      gasFees: 0n,
      gasUsed: 0n,
      gasLimit: 0n,
      mode: 0,
      exitCode: 0,
      vmSteps: 0,
      vmInitStateHash: 0n,
      vmFinalStateHash: 0n,
    },
    actionPhase: {
      success: options.actionSuccess ?? true,
      valid: true,
      noFunds: false,
      statusChange: "unchanged" as const,
      resultCode: 0,
      totalActions: 1,
      specActions: 0,
      skippedActions: 0,
      messagesCreated: 1,
      actionListHash: 0n,
      totalMessageSize: { cells: 1n, bits: 1n },
    },
    aborted: options.aborted ?? false,
    destroyed: false,
  };
}

describe("TonClient SDK adapter", () => {
  it("fails closed on aborted, compute-failed and action-failed transactions", () => {
    expect(transactionSucceeded(genericDescription({}))).toBe(true);
    expect(transactionSucceeded(genericDescription({ aborted: true }))).toBe(false);
    expect(transactionSucceeded(genericDescription({ computeSuccess: false }))).toBe(false);
    expect(transactionSucceeded(genericDescription({ actionSuccess: false }))).toBe(false);
  });

  it("uses archival pagination, an exclusive cursor and only external-out logs", async () => {
    const outMessages = Dictionary.empty<number, never>();
    outMessages.set(0, {
      info: {
        type: "external-out",
        src: ADDRESS,
        createdLt: 10n,
        createdAt: 1,
      },
      body: beginCell().storeUint(1, 32).endCell(),
    } as never);
    outMessages.set(1, {
      info: {
        type: "internal",
        ihrDisabled: true,
        bounce: true,
        bounced: false,
        src: ADDRESS,
        dest: ADDRESS,
        value: { coins: 1n },
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: 11n,
        createdAt: 1,
      },
      body: beginCell().endCell(),
    } as never);
    const getTransactions = vi.fn()
      .mockResolvedValueOnce([{
        lt: 123n,
        hash: () => Buffer.alloc(32, 0x23),
        inMessage: {
          info: {
            type: "internal",
            src: ADDRESS,
            bounced: true,
          },
          body: beginCell().storeUint(2, 32).endCell(),
        },
        outMessages,
        description: genericDescription({}),
      }])
      .mockResolvedValueOnce([]);
    const sdk = makeSdkClient({ getTransactions } as unknown as TonClient);

    const before = {
      lt: "500",
      hash: Buffer.alloc(32, 0x42).toString("base64"),
    };
    const result = await sdk.getTransactions(ADDRESS.toString(), 100, before);

    const [calledAddress, calledOptions] = getTransactions.mock.calls[0]!;
    expect(calledAddress.equals(ADDRESS)).toBe(true);
    expect(calledOptions).toEqual({
      limit: 100,
      archival: true,
      lt: before.lt,
      hash: before.hash,
    });
    expect(result.incomplete).toBe(true);
    expect(result.transactions[0]).toMatchObject({
      lt: "123",
      hash: Buffer.alloc(32, 0x23).toString("base64"),
      block_seqno: 0,
      success: true,
      in_msg: { bounced: true },
      out_msgs: [
        { index: 0, isExternal: true },
        { index: 1, isExternal: false },
      ],
    });

    const exhausted = await sdk.getTransactions(ADDRESS.toString(), 100, undefined);
    expect(exhausted).toEqual({ transactions: [], incomplete: false });
  });
});
