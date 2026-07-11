/**
 * CLI error model.
 *
 * Throw a `CliError` to abort a command with a human message + suggested
 * remediation. The top-level handler in `index.ts` formats and exits with
 * the right code (pretty to stderr, or structured JSON to stdout under
 * `--json`).
 *
 * Use `code` from the catalog below so callers (agents, scripts) can branch
 * on the error class without parsing the message.
 */

export type ErrorCode =
  | "CLI_ERROR"
  | "INVALID_ARG"
  | "CANCELLED"
  | "WALLET_NOT_FOUND"
  | "WALLET_LOCKED"
  | "WALLET_ALREADY_EXISTS"
  | "INVALID_MNEMONIC"
  | "INVALID_NOTE"
  | "INVALID_ADDRESS"
  | "POOL_NOT_FOUND"
  | "POOL_AMBIGUOUS"
  | "POOL_ALREADY_EXISTS"
  | "POOL_CREATION_PENDING"
  | "INSUFFICIENT_BALANCE"
  | "DEPOSIT_JOURNAL_FAILED"
  | "DEPOSIT_BROADCAST_AMBIGUOUS"
  | "NETWORK_NOT_SUPPORTED"
  | "NETWORK_ERROR"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_INTEGRITY"
  | "DECRYPT_FAILED";

export class CliError extends Error {
  override readonly name = "CliError";
  readonly exitCode: number;
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      code?: ErrorCode;
      exitCode?: number;
      hint?: string;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.exitCode = opts.exitCode ?? 1;
    this.code = opts.code ?? "CLI_ERROR";
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

export function isCliError(e: unknown): e is CliError {
  return e instanceof CliError;
}
