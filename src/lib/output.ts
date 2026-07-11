/**
 * Output envelope — switches between human-pretty and JSON on `--json`.
 *
 * Matches the Acton CLI convention:
 *   { "success": true, ...payload }            // happy path
 *   { "success": false, "error": "CODE",       // error path
 *     "message": "...", "details": {...}, "hint": "..." }
 *
 * stdout is the result channel. stderr is for progress/log noise. Never mix.
 */

import pc from "picocolors";
import { CliError } from "./errors.js";

export type ColorMode = "auto" | "always" | "never";

export interface EmitOpts {
  json?: boolean;
  /** "auto" | "always" | "never". Other strings fall back to "auto". */
  color?: string;
}

export function resolveColor(mode: string | undefined): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== "1";
}

/**
 * Print the command's result.
 *
 * - `--json` → stringify the envelope to stdout, no decoration
 * - otherwise → invoke the `pretty` renderer
 *
 * The `pretty` callback may write to stdout with whatever formatting it wants.
 */
export function emit<T extends Record<string, unknown>>(
  data: T,
  opts: EmitOpts,
  pretty: (data: T) => void,
): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ success: true, ...data }, replacer, 2) + "\n");
    return;
  }
  pretty(data);
}

/**
 * Print an error envelope. In JSON mode, write structured payload to stdout
 * (so callers can parse it). Otherwise, write to stderr.
 *
 * Returns the exit code to use.
 */
export function emitError(err: unknown, opts: EmitOpts): number {
  const useJson = Boolean(opts.json);
  const useColor = !useJson && resolveColor(opts.color);

  if (err instanceof CliError) {
    if (useJson) {
      process.stdout.write(
        JSON.stringify(
          {
            success: false,
            error: err.code ?? "CLI_ERROR",
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
            ...(err.hint ? { hint: err.hint } : {}),
          },
          replacer,
          2,
        ) + "\n",
      );
    } else {
      const tag = useColor ? pc.red("error") : "error";
      process.stderr.write(`\n${tag} ${err.message}\n`);
      if (err.hint) {
        const hintTag = useColor ? pc.dim("hint:") : "hint:";
        process.stderr.write(`${hintTag} ${err.hint}\n`);
      }
    }
    return err.exitCode;
  }

  const e = err as Error;
  if (useJson) {
    process.stdout.write(
      JSON.stringify(
        {
          success: false,
          error: "INTERNAL_ERROR",
          message: e?.message ?? String(err),
          ...(e?.stack ? { stack: e.stack } : {}),
        },
        replacer,
        2,
      ) + "\n",
    );
  } else {
    const tag = useColor ? pc.red("unexpected error") : "unexpected error";
    process.stderr.write(`\n${tag}\n`);
    process.stderr.write(e?.stack ?? e?.message ?? String(err));
    process.stderr.write("\n");
  }
  return 1;
}

/** Tag a side-channel progress message (stderr). Silent in JSON mode. */
export function progress(msg: string, opts: EmitOpts): void {
  if (opts.json) return;
  const useColor = resolveColor(opts.color);
  const dot = useColor ? pc.dim("·") : "·";
  process.stderr.write(`  ${dot} ${msg}\n`);
}

/**
 * JSON.stringify replacer that turns bigint into string (numeric form, no quotes-in-quotes
 * confusion). All amounts in nanoTON / jetton-units fit in regular bigints but exceed
 * Number.MAX_SAFE_INTEGER for large denominations, so we always emit decimal strings.
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
