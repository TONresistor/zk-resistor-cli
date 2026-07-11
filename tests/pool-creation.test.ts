import { Address, beginCell } from "@ton/core";
import type { Client } from "@tonresistor/zkresistor-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  planJettonPoolCreation,
  planTonPoolCreation,
} from "../src/lib/pool-creation.js";

const FACTORY = Address.parseRaw(`0:${"11".repeat(32)}`).toString();
const MASTER = Address.parseRaw(`0:${"22".repeat(32)}`).toString();
const EXPECTED = Address.parseRaw(`0:${"33".repeat(32)}`).toString();
const EXISTING = Address.parseRaw(`0:${"44".repeat(32)}`).toString();

function addressStack(address: string): string {
  return beginCell().storeAddress(Address.parse(address)).endCell()
    .toBoc().toString("base64");
}

function creationClient(options: {
  pending?: boolean;
  existing?: string | null;
  expected?: string;
} = {}): Client {
  return {
    async getAccountState() { throw new Error("unused"); },
    async getTransactions() { throw new Error("unused"); },
    async runMethod(_address, method) {
      const values: Record<string, string | null> = {
        poolDeploymentPending: options.pending ? "-1" : "0",
        tonPoolDeploymentPending: options.pending ? "-1" : "0",
        poolAddressFor: options.existing ? addressStack(options.existing) : null,
        tonPoolAddressFor: options.existing ? addressStack(options.existing) : null,
        expectedPoolAddress: addressStack(options.expected ?? EXPECTED),
        expectedTonPoolAddress: addressStack(options.expected ?? EXPECTED),
      };
      if (!(method in values)) throw new Error(`unexpected getter: ${method}`);
      return { exit_code: 0, stack: [values[method] ?? null] };
    },
  };
}

describe("pool creation guards", () => {
  it("builds plans only for unused Jetton and TON denominations", async () => {
    const jetton = await planJettonPoolCreation(
      creationClient(),
      FACTORY,
      MASTER,
      1_000n,
    );
    expect(jetton).toMatchObject({
      poolAddress: EXPECTED,
      message: { address: FACTORY, value: 550_000_000n },
    });

    const ton = await planTonPoolCreation(
      creationClient(),
      FACTORY,
      10_000_000_000n,
    );
    expect(ton).toMatchObject({
      poolAddress: EXPECTED,
      message: { address: FACTORY, value: 550_000_000n },
    });
  });

  it("rejects pending Jetton and TON creations", async () => {
    await expect(planJettonPoolCreation(
      creationClient({ pending: true }),
      FACTORY,
      MASTER,
      1_000n,
    )).rejects.toMatchObject({
      code: "POOL_CREATION_PENDING",
      details: { pool: EXPECTED },
    });
    await expect(planTonPoolCreation(
      creationClient({ pending: true }),
      FACTORY,
      10_000_000_000n,
    )).rejects.toMatchObject({
      code: "POOL_CREATION_PENDING",
      details: { pool: EXPECTED },
    });
  });

  it("rejects existing Jetton and TON pools", async () => {
    await expect(planJettonPoolCreation(
      creationClient({ existing: EXISTING }),
      FACTORY,
      MASTER,
      1_000n,
    )).rejects.toMatchObject({
      code: "POOL_ALREADY_EXISTS",
      details: { pool: EXISTING },
    });
    await expect(planTonPoolCreation(
      creationClient({ existing: EXISTING }),
      FACTORY,
      10_000_000_000n,
    )).rejects.toMatchObject({
      code: "POOL_ALREADY_EXISTS",
      details: { pool: EXISTING },
    });
  });

  it("rejects a non-positive Jetton denomination before RPC", async () => {
    const runMethod = vi.fn();
    const client = {
      ...creationClient(),
      runMethod,
    };
    await expect(planJettonPoolCreation(
      client,
      FACTORY,
      MASTER,
      0n,
    )).rejects.toMatchObject({ code: "INVALID_ARG" });
    expect(runMethod).not.toHaveBeenCalled();
  });
});
