import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadZkrConfig } from "../src/lib/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeConfigDirs(): Promise<{ root: string; projectDir: string; userConfigDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "zkr-config-test-"));
  tempDirs.push(root);
  const projectDir = join(root, "project");
  const userConfigDir = join(root, "user");
  await Promise.all([mkdir(projectDir), mkdir(userConfigDir)]);
  return { root, projectDir, userConfigDir };
}

describe("loadZkrConfig", () => {
  it("defaults to package-relative circuit artifacts", async () => {
    const { projectDir, userConfigDir } = await makeConfigDirs();
    const cfg = await loadZkrConfig({ projectDir, userConfigDir, env: {} });

    expect(cfg.network).toBe("mainnet");
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const artifacts = join(packageRoot, "artifacts", "circuits");
    expect(cfg.hasherWasm).toBe(join(artifacts, "hasher.wasm"));
    expect(cfg.insertWasm).toBe(join(artifacts, "insert.wasm"));
    expect(cfg.insertZkey).toBe(join(artifacts, "insert_final.zkey"));
    expect(cfg.withdrawWasm).toBe(join(artifacts, "withdraw.wasm"));
    expect(cfg.withdrawZkey).toBe(join(artifacts, "withdraw_final.zkey"));
    expect(cfg.stateDir).toBe(join(userConfigDir, "state"));
  });

  it("layers user, project and environment config in that order", async () => {
    const { projectDir, userConfigDir } = await makeConfigDirs();
    await writeFile(
      join(userConfigDir, "config.json"),
      JSON.stringify({ network: "testnet", stateDir: "/user/state", hasherWasm: "/user/hasher" }),
    );
    await writeFile(
      join(projectDir, "zkresistor.config.json"),
      JSON.stringify({ stateDir: "/project/state", hasherWasm: "/project/hasher" }),
    );

    const cfg = await loadZkrConfig({
      projectDir,
      userConfigDir,
      env: { ZKR_NET: "mainnet", ZKR_HASHER_WASM: "/env/hasher" },
    });

    expect(cfg.network).toBe("mainnet");
    expect(cfg.stateDir).toBe("/project/state");
    expect(cfg.hasherWasm).toBe("/env/hasher");
  });

  it("ignores executable config formats", async () => {
    const { projectDir, userConfigDir } = await makeConfigDirs();
    await writeFile(join(projectDir, "zkresistor.config.js"), 'throw new Error("must not execute");');
    await writeFile(join(projectDir, "zkresistor.config.ts"), 'throw new Error("must not execute");');

    const cfg = await loadZkrConfig({ projectDir, userConfigDir, env: {} });

    expect(cfg.network).toBe("mainnet");
  });

  it("fails closed on malformed JSON", async () => {
    const { projectDir, userConfigDir } = await makeConfigDirs();
    const path = join(projectDir, "zkresistor.config.json");
    await writeFile(path, '{"network":');

    await expect(loadZkrConfig({ projectDir, userConfigDir, env: {} })).rejects.toMatchObject({
      code: "INVALID_ARG",
      details: { source: path },
    });
  });

  it("rejects unknown keys, including secret material", async () => {
    const { projectDir, userConfigDir } = await makeConfigDirs();
    await writeFile(
      join(projectDir, "zkresistor.config.json"),
      JSON.stringify({ passphrase: "do-not-put-secrets-here" }),
    );

    await expect(loadZkrConfig({ projectDir, userConfigDir, env: {} })).rejects.toThrow(
      /unknown key\(s\): passphrase/,
    );
  });

  it.each([
    ["non-object config", []],
    ["invalid network", { network: "localnet" }],
    ["non-string path", { stateDir: 42 }],
    ["empty path", { withdrawZkey: "  " }],
  ])("rejects %s", async (_label, value) => {
    const { projectDir, userConfigDir } = await makeConfigDirs();
    await writeFile(join(projectDir, "zkresistor.config.json"), JSON.stringify(value));

    await expect(loadZkrConfig({ projectDir, userConfigDir, env: {} })).rejects.toMatchObject({
      code: "INVALID_ARG",
    });
  });

  it("validates environment overrides", async () => {
    const { projectDir, userConfigDir } = await makeConfigDirs();

    await expect(
      loadZkrConfig({ projectDir, userConfigDir, env: { ZKR_NETWORK: "main-net" } }),
    ).rejects.toThrow(/environment.*network.*mainnet.*testnet/);
  });
});
