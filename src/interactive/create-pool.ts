import * as p from "../lib/prompts.js";
import { TON_POOL_DENOMINATIONS } from "@tonresistor/zkresistor-sdk";
import { formatGram } from "../lib/format.js";
import {
  canonicalAddress,
  positiveBigInt,
} from "../lib/validation.js";
import type { ExecuteCommand, InteractiveSession } from "./types.js";
import { ensureWallet } from "./wallets.js";

export async function createPoolMenu(
  session: InteractiveSession,
  execute: ExecuteCommand,
): Promise<void> {
  const action = await p.select({
    message: "Create Pool",
    options: [
      { value: "gram", label: "GRAM Pool" },
      { value: "jetton", label: "Jetton Pool" },
      { value: "activate", label: "Activate Pending Jetton Pool" },
      { value: "back", label: "Back" },
    ],
  });
  if (p.isCancel(action) || action === "back") return;

  const wallet = await ensureWallet(session);
  if (wallet === undefined) return;

  if (action === "gram") {
    const denomination = await p.select({
      message: "Fixed denomination",
      options: TON_POOL_DENOMINATIONS.map((value) => ({
        value: value.toString(),
        label: formatGram(value),
      })),
    });
    if (p.isCancel(denomination)) return;
    const selectedDenomination = String(denomination);
    await execute([
      "pool",
      "create-ton",
      "--denom",
      selectedDenomination,
      "--wallet",
      wallet.name,
      "--net",
      session.network,
    ]);
    return;
  }

  if (action === "jetton") {
    const jetton = await p.text({
      message: "Jetton master address",
      validate: (value) => validateAddress(value, "Jetton master"),
    });
    if (p.isCancel(jetton)) return;
    const denomination = await p.text({
      message: "Denomination in smallest Jetton units",
      placeholder: "1000000000000",
      validate: validatePositiveInteger,
    });
    if (p.isCancel(denomination)) return;
    await execute([
      "pool",
      "create",
      "--jetton",
      jetton.trim(),
      "--denom",
      denomination.trim(),
      "--wallet",
      wallet.name,
      "--net",
      session.network,
    ]);
    return;
  }

  const address = await p.text({
    message: "Pending Pool address",
    validate: (value) => validateAddress(value, "Pool address"),
  });
  if (p.isCancel(address)) return;
  await execute([
    "pool",
    "activate",
    address.trim(),
    "--wallet",
    wallet.name,
    "--net",
    session.network,
  ]);
}

function validateAddress(value: string, label: string): string | undefined {
  try {
    canonicalAddress(value.trim(), label);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : `Invalid ${label}.`;
  }
}

function validatePositiveInteger(value: string): string | undefined {
  try {
    positiveBigInt(value.trim(), "Denomination");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid denomination.";
  }
}
