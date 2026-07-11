/**
 * Output helpers — wraps @clack/prompts + consola + picocolors.
 *
 * - `ui.intro(...)`/`ui.outro(...)` for top + bottom of an interactive flow.
 * - `ui.note(...)` for blocks of read-only info.
 * - `ui.task(label, fn)` for a single async step with spinner.
 * - `ui.confirm/text/select/password` thin re-exports for type ergonomics.
 * - `ui.log` is a non-interactive consola instance for plain stdout lines.
 */

import * as p from "@clack/prompts";
import { consola } from "consola";
import pc from "picocolors";

export const colors = pc;

export const log = consola.create({
  defaults: { tag: "zkr" },
});

export const ui = {
  intro: (title: string) => p.intro(pc.cyan(pc.bold(title))),
  outro: (msg: string) => p.outro(pc.green(msg)),
  note: (body: string, title?: string) => p.note(body, title),
  log,
  /** Run an async step under a spinner. Re-throws on error after stopping it. */
  task: async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const s = p.spinner();
    s.start(label);
    try {
      const out = await fn();
      s.stop(pc.green("✓ ") + label);
      return out;
    } catch (e) {
      s.stop(pc.red("✗ ") + label);
      throw e;
    }
  },
  confirm: p.confirm,
  text: p.text,
  password: p.password,
  select: p.select,
  cancel: p.cancel,
  isCancel: p.isCancel,
};

export function fmtTon(nano: bigint): string {
  const sign = nano < 0n ? "-" : "";
  const n = nano < 0n ? -nano : nano;
  const whole = n / 1_000_000_000n;
  const frac = (n % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? "." + frac : ""} TON`;
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
