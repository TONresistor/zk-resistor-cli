import { Address, beginCell } from "@ton/core";
import { describe, expect, it } from "vitest";
import type { Client } from "@tonresistor/zkresistor-sdk";
import {
  buildPoolActivationMessage,
  planPoolActivation,
} from "../src/lib/pool-activation.js";

const FACTORY = Address.parseRaw(`0:${"22".repeat(32)}`).toString();
const OTHER_FACTORY = Address.parseRaw(`0:${"33".repeat(32)}`).toString();
const MASTER = Address.parseRaw(`0:${"44".repeat(32)}`).toString();

function addressStack(address: string): string {
  return beginCell().storeAddress(Address.parse(address)).endCell()
    .toBoc().toString("base64");
}

function activationClient(options: {
  poolAddress: string;
  actualFactory?: string;
  registeredPool?: string | null;
  wallet?: string | null;
  pending?: boolean;
  rejectJettonGetter?: boolean;
}): Client {
  return {
    async getAccountState() { throw new Error("unused"); },
    async getTransactions() { throw new Error("unused"); },
    async runMethod(_address, method) {
      if (method === "jettonMaster" && options.rejectJettonGetter) {
        return { exit_code: 11, stack: [] };
      }
      const values: Record<string, string | null> = {
        factory: addressStack(options.actualFactory ?? FACTORY),
        jettonMaster: addressStack(MASTER),
        denomination: "1000",
        jettonWallet: options.wallet === undefined
          ? null
          : options.wallet === null ? null : addressStack(options.wallet),
        poolAddressFor: options.registeredPool === null
          ? null
          : addressStack(options.registeredPool ?? options.poolAddress),
        poolDeploymentPending: options.pending === false ? "0" : "-1",
      };
      return { exit_code: 0, stack: [values[method] ?? null] };
    },
  };
}

describe("pool activation message", () => {
  it("builds the exact InitWalletBinding message used by CLI and MCP", () => {
    const poolAddress = Address.parseRaw(`0:${"11".repeat(32)}`).toString({
      urlSafe: true,
      bounceable: true,
    });
    const message = buildPoolActivationMessage(poolAddress, 42n);
    const payload = message.payload.beginParse();

    expect(message.address).toBe(poolAddress);
    expect(message.value).toBe(60_000_000n);
    expect(message.queryId).toBe(42n);
    expect(payload.loadUint(32)).toBe(0xa0c0c0c1);
    expect(payload.loadUintBig(64)).toBe(42n);
    expect(payload.remainingBits).toBe(0);
    expect(payload.remainingRefs).toBe(0);
  });

  it("plans only a registered pending Jetton Pool", async () => {
    const poolAddress = Address.parseRaw(`0:${"11".repeat(32)}`).toString();
    const plan = await planPoolActivation(
      activationClient({ poolAddress }),
      FACTORY,
      poolAddress,
      42n,
    );
    expect(plan.status).toBe("pending");
    expect(plan.walletBound).toBe(false);
    expect(plan.message?.value).toBe(60_000_000n);
  });

  it("uses the bound-wallet confirmation budget", async () => {
    const poolAddress = Address.parseRaw(`0:${"11".repeat(32)}`).toString();
    const wallet = Address.parseRaw(`0:${"55".repeat(32)}`).toString();
    const plan = await planPoolActivation(
      activationClient({ poolAddress, wallet }),
      FACTORY,
      poolAddress,
    );
    expect(plan.walletBound).toBe(true);
    expect(plan.message?.value).toBe(20_000_000n);
  });

  it("does not build a transaction for an already active Pool", async () => {
    const poolAddress = Address.parseRaw(`0:${"11".repeat(32)}`).toString();
    const plan = await planPoolActivation(
      activationClient({ poolAddress, pending: false }),
      FACTORY,
      poolAddress,
    );
    expect(plan).toMatchObject({ status: "active", message: null });
  });

  it("fails closed for another Factory, an unregistered Pool or a TonPool", async () => {
    const poolAddress = Address.parseRaw(`0:${"11".repeat(32)}`).toString();
    await expect(planPoolActivation(
      activationClient({ poolAddress, actualFactory: OTHER_FACTORY }),
      FACTORY,
      poolAddress,
    )).rejects.toThrow(/another Factory/);
    await expect(planPoolActivation(
      activationClient({ poolAddress, registeredPool: null }),
      FACTORY,
      poolAddress,
    )).rejects.toThrow(/not registered/);
    await expect(planPoolActivation(
      activationClient({ poolAddress, rejectJettonGetter: true }),
      FACTORY,
      poolAddress,
    )).rejects.toThrow(/not an active Jetton Pool/);
  });
});
