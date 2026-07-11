#!/usr/bin/env node
/**
 * zkr — ZKResistor CLI entrypoint.
 *
 * Top-level command tree:
 *   zkr wallet  · new / import / list / show / remove / export-mnemonic / sign
 *   zkr pools   · list / info
 *   zkr pool    · create / create-ton / activate
 *   zkr deposit
 *   zkr withdraw
 *   zkr mcp     · serve
 */

import { defineCommand, runCommand, showUsage } from "citty";
import wallet from "./commands/wallet/index.js";
import pools from "./commands/pools/index.js";
import pool from "./commands/pool/index.js";
import deposit from "./commands/deposit.js";
import withdraw from "./commands/withdraw.js";
import mcp from "./commands/mcp/index.js";
import { emitError } from "./lib/output.js";

// Suppress raw Node deprecation noise — only relevant to library authors.
process.removeAllListeners("warning");

const main = defineCommand({
  meta: {
    name: "zkr",
    version: "2.0.0",
    description: "ZKResistor CLI — trustless ZK privacy pool on TON.",
  },
  subCommands: {
    wallet,
    pools,
    pool,
    deposit,
    withdraw,
    mcp,
  },
});

// Replicate citty's `runMain` behavior but own the error handler. The
// default `runMain` catches with consola.error which clobbers our JSON
// envelope on failure.
(async () => {
  const rawArgs = process.argv.slice(2);
  try {
    // Handle --version at the very top.
    if (rawArgs[0] === "--version" || rawArgs[0] === "-v") {
      const meta = (typeof main.meta === "function" ? await main.meta() : main.meta) as
        | { version?: string }
        | undefined;
      process.stdout.write((meta?.version ?? "0.0.0") + "\n");
      process.exit(0);
    }
    // Walk subCommands to find which level a trailing --help applies to.
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cmd: any = main;
      for (const a of rawArgs) {
        if (a.startsWith("-")) break;
        const subs = cmd.subCommands;
        const next = typeof subs === "function" ? await subs() : subs;
        if (next && a in next) {
          const def = next[a];
          cmd = typeof def === "function" ? await def() : def;
        } else {
          break;
        }
      }
      await showUsage(cmd);
      process.exit(0);
    }
    await runCommand(main, { rawArgs });
  } catch (err) {
    const json = rawArgs.includes("--json");
    const colorArgIdx = rawArgs.findIndex((a) => a === "--color");
    const color = colorArgIdx >= 0 ? rawArgs[colorArgIdx + 1] : undefined;
    process.exit(emitError(err, { json, ...(color ? { color } : {}) }));
  }
})();
