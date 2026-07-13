import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

export interface ZkrConfig {
  network?: "mainnet" | "testnet";
  hasherWasm?: string;
  insertWasm?: string;
  insertZkey?: string;
  withdrawWasm?: string;
  withdrawZkey?: string;
  stateDir?: string;
}

export const CONFIG_DIR = join(homedir(), ".config", "zkresistor");

export interface LoadZkrConfigOptions {
  projectDir?: string;
  userConfigDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

const CONFIG_KEYS = [
  "network",
  "hasherWasm",
  "insertWasm",
  "insertZkey",
  "withdrawWasm",
  "withdrawZkey",
  "stateDir",
] as const;

const PATH_KEYS = CONFIG_KEYS.filter((key) => key !== "network");
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;

function findPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  const filesystemRoot = parse(current).root;
  while (current !== filesystemRoot) {
    if (existsSync(join(current, "package.json"))) return current;
    current = dirname(current);
  }
  throw new Error("Cannot locate the ZKResistor CLI package root");
}

export const PACKAGE_ROOT = findPackageRoot();
const CIRCUIT_ARTIFACTS_DIR = join(PACKAGE_ROOT, "artifacts", "circuits");

function defaults(configDir: string): Required<ZkrConfig> {
  return {
    network: "mainnet",
    hasherWasm: join(CIRCUIT_ARTIFACTS_DIR, "hasher.wasm"),
    insertWasm: join(CIRCUIT_ARTIFACTS_DIR, "insert.wasm"),
    insertZkey: join(CIRCUIT_ARTIFACTS_DIR, "insert_final.zkey"),
    withdrawWasm: join(CIRCUIT_ARTIFACTS_DIR, "withdraw.wasm"),
    withdrawZkey: join(CIRCUIT_ARTIFACTS_DIR, "withdraw_final.zkey"),
    stateDir: join(configDir, "state"),
  };
}

function configError(source: string, reason: string): CliError {
  return new CliError(`Invalid ZKResistor config at ${source}: ${reason}`, {
    code: "INVALID_ARG",
    hint: "Use a JSON object containing only documented non-secret config keys.",
    details: { source },
  });
}

function validateConfig(value: unknown, source: string): ZkrConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configError(source, "the top-level value must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(CONFIG_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw configError(source, `unknown key(s): ${unknownKeys.sort().join(", ")}`);
  }

  const config: ZkrConfig = {};
  if (record.network !== undefined) {
    if (record.network !== "mainnet" && record.network !== "testnet") {
      throw configError(source, '"network" must be "mainnet" or "testnet"');
    }
    config.network = record.network;
  }

  for (const key of PATH_KEYS) {
    const path = record[key];
    if (path === undefined) continue;
    if (
      typeof path !== "string" ||
      path.trim().length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      path.includes("\0")
    ) {
      throw configError(
        source,
        `"${key}" must be a non-empty path string of at most ${MAX_PATH_LENGTH} characters`,
      );
    }
    config[key] = path;
  }

  return config;
}

async function readJsonConfig(path: string): Promise<ZkrConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    const reason = error instanceof Error ? error.message : String(error);
    throw configError(path, `cannot read file (${reason})`);
  }

  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw configError(path, `file exceeds ${MAX_CONFIG_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw configError(path, "malformed JSON");
  }
  return validateConfig(parsed, path);
}

function readEnvConfig(env: Readonly<Record<string, string | undefined>>): ZkrConfig {
  return validateConfig(
    {
      network: env.ZKR_NET ?? env.ZKR_NETWORK,
      hasherWasm: env.ZKR_HASHER_WASM,
      insertWasm: env.ZKR_INSERT_WASM,
      insertZkey: env.ZKR_INSERT_ZKEY,
      withdrawWasm: env.ZKR_WITHDRAW_WASM,
      withdrawZkey: env.ZKR_WITHDRAW_ZKEY,
      stateDir: env.ZKR_STATE_DIR,
    },
    "environment",
  );
}

export async function loadZkrConfig(
  options: LoadZkrConfigOptions = {},
): Promise<Required<ZkrConfig>> {
  const projectDir = options.projectDir ?? process.cwd();
  const userConfigDir = options.userConfigDir ?? CONFIG_DIR;
  const env = options.env ?? process.env;

  const user = await readJsonConfig(join(userConfigDir, "config.json"));
  const project = await readJsonConfig(join(projectDir, "zkresistor.config.json"));
  const environment = readEnvConfig(env);

  return {
    ...defaults(userConfigDir),
    ...user,
    ...project,
    ...environment,
  };
}
