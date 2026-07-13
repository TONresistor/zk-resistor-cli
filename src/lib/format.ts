import type { PoolInfo } from "@tonresistor/zkresistor-sdk";

export function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Decimals must be an integer between 0 and 255");
  }
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatGram(nano: bigint): string {
  return `${formatUnits(nano, 9)} GRAM`;
}

export function formatPoolAmount(pool: PoolInfo): string {
  return pool.kind === "ton"
    ? formatUnits(pool.denomination, 9)
    : formatUnits(pool.denomination, pool.jettonDecimals);
}

export function formatPoolDenomination(pool: PoolInfo): string {
  return `${formatPoolAmount(pool)} ${displayPoolAsset(pool)}`;
}

export function displayPoolAsset(pool: PoolInfo): string {
  return pool.kind === "ton" ? "GRAM" : pool.jettonSymbol;
}

export function notePoolAsset(pool: PoolInfo): string {
  return pool.kind === "ton" ? "TON" : pool.jettonSymbol;
}

export function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}
