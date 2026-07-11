/**
 * Shared argument specs spreadable into every `defineCommand({ args })`.
 *
 * The Acton CLI convention is that every command supports `--json` and
 * `--color`, and every chain-touching command supports `--net`. Citty doesn't
 * auto-inherit subcommand args, so we spread these where needed.
 *
 * Usage:
 *   args: {
 *     ...outputArgs,
 *     ...networkArgs,
 *     name: { type: "string" },
 *   }
 */

export const outputArgs = {
  json: {
    type: "boolean",
    description: "Output result as JSON.",
    default: false,
  },
  color: {
    type: "string",
    description: "Control when to use colored output: auto | always | never.",
    default: "auto",
  },
} as const;

export const networkArgs = {
  net: {
    type: "string",
    description: "Network to query: mainnet | testnet.",
  },
} as const;

export const walletArg = {
  wallet: {
    type: "string",
    description: "Local wallet name (use `zkr wallet list` to enumerate).",
    default: "default",
  },
} as const;

export const yesArg = {
  yes: {
    type: "boolean",
    alias: "y",
    description: "Skip confirmation prompt.",
    default: false,
  },
} as const;
