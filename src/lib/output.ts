import pc from "picocolors";
import { CliError } from "./errors.js";

export type ColorMode = "auto" | "always" | "never";

export interface EmitOpts {
  json?: boolean;
  color?: string;
}

export function resolveColor(mode: string | undefined): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== "1";
}

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

export function progress(msg: string, opts: EmitOpts): void {
  if (opts.json) return;
  const useColor = resolveColor(opts.color);
  const dot = useColor ? pc.dim("·") : "·";
  process.stderr.write(`  ${dot} ${msg}\n`);
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
