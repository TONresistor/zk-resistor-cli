import { Address } from "@ton/core";
import { describe, expect, it } from "vitest";
import type { Note, PoolInfo } from "@tonresistor/zkresistor-sdk";
import {
  formatPoolDenomination,
  formatUnits,
  notePoolAsset,
} from "../src/lib/format.js";
import {
  canonicalAddress,
  canonicalRecipientAddress,
  notePoolBinding,
  optionalUint64,
  positiveBigInt,
} from "../src/lib/validation.js";
import { filterPools } from "../src/lib/pools.js";

const POOL = Address.parseRaw(`0:${"11".repeat(32)}`).toString();
const OTHER_POOL = Address.parseRaw(`0:${"22".repeat(32)}`).toString();

describe("formatting", () => {
  it("formats fractional units without losing precision", () => {
    expect(formatUnits(1_234_500n, 4)).toBe("123.45");
    expect(formatUnits(-1n, 2)).toBe("-0.01");
  });

  it("keeps native note encoding compatible while displaying GRAM", () => {
    const pool: PoolInfo = {
      kind: "ton",
      poolAddress: POOL,
      denomination: 10_000_000_000n,
      nextIndex: 0,
      capacity: 1_048_576,
      currentRoot: 0n,
      pendingWithdrawTon: 0n,
    };
    expect(notePoolAsset(pool)).toBe("TON");
    expect(formatPoolDenomination(pool)).toBe("10 GRAM");
  });

  it("filters the Pool catalog by kind, token metadata, and full address", () => {
    const gram: PoolInfo = {
      kind: "ton",
      poolAddress: POOL,
      denomination: 10_000_000_000n,
      nextIndex: 3,
      capacity: 1_048_576,
      currentRoot: 0n,
      pendingWithdrawTon: 30_000_000_000n,
    };
    const jetton: PoolInfo = {
      kind: "jetton",
      poolAddress: OTHER_POOL,
      denomination: 1_000_000_000n,
      nextIndex: 2,
      capacity: 1_048_576,
      currentRoot: 0n,
      jettonMaster: Address.parseRaw(`0:${"33".repeat(32)}`).toString(),
      jettonSymbol: "ZOICH",
      jettonDecimals: 6,
      jettonImage: null,
      jettonName: "Zoich Coin",
      jettonWallet: null,
    };
    expect(filterPools([gram, jetton], "ton")).toEqual([gram]);
    expect(filterPools([gram, jetton], "all", "zoich")).toEqual([jetton]);
    expect(filterPools([gram, jetton], "all", OTHER_POOL)).toEqual([jetton]);
  });
});

describe("validation", () => {
  it("canonicalizes addresses and validates unsigned integer inputs", () => {
    expect(canonicalAddress(Address.parse(POOL).toRawString(), "pool")).toBe(POOL);
    expect(positiveBigInt("42", "Amount")).toBe(42n);
    expect(optionalUint64("18446744073709551615")).toBe((1n << 64n) - 1n);
    expect(canonicalRecipientAddress(POOL)).toBe(POOL);
    expect(() => positiveBigInt("0", "Amount")).toThrow(/positive integer/);
    expect(() => optionalUint64("18446744073709551616")).toThrow(/unsigned 64-bit/);
    expect(() => canonicalRecipientAddress(`0:${"00".repeat(32)}`)).toThrow(
      /non-zero basechain/,
    );
  });

  it("rejects a pool override that conflicts with the note", () => {
    const note: Note = {
      asset: "TON",
      denominationUnits: 10_000_000_000n,
      leafIndex: 0,
      nullifier: 1n,
      secret: 2n,
      poolAddress: POOL,
      poolKind: "ton",
    };
    expect(notePoolBinding(note)).toEqual({ poolAddress: POOL, kind: "ton" });
    expect(() => notePoolBinding(note, OTHER_POOL)).toThrow(/does not match/);
  });
});
