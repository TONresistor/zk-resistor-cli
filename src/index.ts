#!/usr/bin/env node
import {
  defineCommand,
  runCommand,
  showUsage,
  type CommandDef,
  type Resolvable,
} from "citty";
import wallet from "./commands/wallet/index.js";
import pools from "./commands/pools/index.js";
import pool from "./commands/pool/index.js";
import deposit from "./commands/deposit.js";
import deposits from "./commands/deposits/index.js";
import withdraw from "./commands/withdraw.js";
import mcp from "./commands/mcp/index.js";
import { emitError } from "./lib/output.js";
import { runInteractive } from "./interactive/index.js";

const main = defineCommand({
  meta: {
    name: "zkr",
    version: "2.0.1",
    description: "ZKResistor CLI — trustless ZK privacy pool on TON.",
  },
  subCommands: {
    wallet,
    pools,
    pool,
    deposit,
    deposits,
    withdraw,
    mcp,
  },
});

async function runCli(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  try {
    if (rawArgs[0] === "--version" || rawArgs[0] === "-v") {
      const meta = main.meta === undefined ? undefined : await resolve(main.meta);
      process.stdout.write((meta?.version ?? "0.0.0") + "\n");
      return;
    }
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      let command: CommandDef = main;
      for (const argument of rawArgs) {
        if (argument.startsWith("-") || command.subCommands === undefined) break;
        const subCommands = await resolve(command.subCommands);
        const definition = subCommands[argument];
        if (definition === undefined) break;
        command = await resolve(definition);
      }
      await showUsage(command);
      return;
    }
    if (rawArgs.length === 0) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        await showUsage(main);
        return;
      }
      await runInteractive({
        execute: async (interactiveArgs) => {
          await runCommand(main, { rawArgs: interactiveArgs });
        },
      });
      return;
    }
    await runCommand(main, { rawArgs });
  } catch (err) {
    const json = rawArgs.includes("--json");
    const colorArgIdx = rawArgs.findIndex((a) => a === "--color");
    const color = colorArgIdx >= 0 ? rawArgs[colorArgIdx + 1] : undefined;
    process.exitCode = emitError(err, { json, ...(color ? { color } : {}) });
  }
}

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function"
    ? await (value as () => T | Promise<T>)()
    : await value;
}

void runCli();
