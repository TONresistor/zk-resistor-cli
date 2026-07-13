import { Address } from "@ton/core";
import type { Note } from "@tonresistor/zkresistor-sdk";
import { CliError } from "./errors.js";

const ADDRESS_FORMAT = { urlSafe: true, bounceable: true } as const;
export const WALLET_NAME_REQUIREMENT = "1-32 alphanumerics, dashes, or underscores.";
export const WALLET_NAME_HINT = `Use ${WALLET_NAME_REQUIREMENT}`;

export function isValidWalletName(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(value);
}

export function canonicalAddress(value: string, label: string): string {
  try {
    return Address.parse(value).toString(ADDRESS_FORMAT);
  } catch {
    throw new CliError(`Invalid ${label}: ${value}`, { code: "INVALID_ADDRESS" });
  }
}

export function canonicalRecipientAddress(value: string): string {
  let address: Address;
  try {
    address = Address.parse(value);
  } catch {
    throw new CliError(`Invalid recipient: ${value}`, { code: "INVALID_ADDRESS" });
  }
  if (address.workChain !== 0 || address.hash.every((byte) => byte === 0)) {
    throw new CliError("Recipient must be a non-zero basechain address.", {
      code: "INVALID_ADDRESS",
    });
  }
  return address.toString(ADDRESS_FORMAT);
}

export function sameAddress(left: string, right: string): boolean {
  return Address.parse(left).equals(Address.parse(right));
}

export function positiveBigInt(value: string, label: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliError(`${label} must be a positive integer.`, { code: "INVALID_ARG" });
  }
  return BigInt(value);
}

export function optionalUint64(value: unknown, label = "query id"): bigint | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new CliError(`Invalid ${label}.`, {
      code: "INVALID_ARG",
      hint: `Pass ${label} as a decimal integer.`,
    });
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 64n) {
    throw new CliError(`Invalid ${label}: must fit an unsigned 64-bit integer.`, {
      code: "INVALID_ARG",
      hint: "Use a value from 0 through 18446744073709551615.",
    });
  }
  return parsed;
}

export function notePoolBinding(
  note: Note,
  requestedPool?: string,
): { poolAddress: string; kind: Note["poolKind"] } {
  const poolAddress = canonicalAddress(note.poolAddress, "pool address in note");
  if (requestedPool !== undefined) {
    const requested = canonicalAddress(requestedPool, "pool address");
    if (!sameAddress(requested, poolAddress)) {
      throw new CliError("The requested pool does not match the pool bound to the note.", {
        code: "INVALID_NOTE",
      });
    }
  }
  return { poolAddress, kind: note.poolKind };
}
