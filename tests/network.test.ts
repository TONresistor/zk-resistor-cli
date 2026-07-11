import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfiguredNetwork,
  resolveNetwork,
} from "../src/lib/network.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function configDirs() {
  const root = await mkdtemp(join(tmpdir(), "zkr-network-test-"));
  tempDirs.push(root);
  const projectDir = join(root, "project");
  const userConfigDir = join(root, "user");
  await Promise.all([mkdir(projectDir), mkdir(userConfigDir)]);
  return { projectDir, userConfigDir };
}

describe("resolveNetwork", () => {
  it("defaults to mainnet", () => {
    expect(resolveNetwork(undefined, { env: {} }).network).toBe("mainnet");
  });

  it("accepts explicit testnet", () => {
    expect(resolveNetwork("testnet", { env: {} }).network).toBe("testnet");
  });

  it("rejects unknown networks", () => {
    expect(() => resolveNetwork("rinkeby", { env: {} })).toThrow(/Invalid network/);
  });

  it("CLI flag overrides env", () => {
    expect(resolveNetwork("mainnet", {
      configuredNetwork: "testnet",
      env: { ZKR_NETWORK: "testnet" },
    }).network).toBe("mainnet");
  });

  it("uses the final mainnet Factory by default", () => {
    const net = resolveNetwork("mainnet", { env: {} });
    expect(net.factoryAddress).toBe(
      "EQD3rhFaCusU0715MZonDNj8GuHeA17KygIXkBLkalpkBjle",
    );
    expect(net.tonAccessNetwork).toBe("mainnet");
  });

  it("reads a factory override at resolution time", () => {
    expect(resolveNetwork("mainnet", {
      env: { ZKR_FACTORY_ADDRESS: "EQ-custom" },
    }).factoryAddress).toBe("EQ-custom");
  });

  it("uses the project JSON network when --net and env are omitted", async () => {
    const { projectDir, userConfigDir } = await configDirs();
    await writeFile(
      join(projectDir, "zkresistor.config.json"),
      JSON.stringify({ network: "testnet" }),
    );

    const net = await resolveConfiguredNetwork(undefined, {
      projectDir,
      userConfigDir,
      env: {},
    });

    expect(net.network).toBe("testnet");
    expect(net.tonAccessNetwork).toBe("testnet");
  });

  it("keeps CLI > env > project JSON > user JSON precedence", async () => {
    const { projectDir, userConfigDir } = await configDirs();
    await writeFile(
      join(userConfigDir, "config.json"),
      JSON.stringify({ network: "mainnet" }),
    );
    await writeFile(
      join(projectDir, "zkresistor.config.json"),
      JSON.stringify({ network: "testnet" }),
    );

    expect((await resolveConfiguredNetwork(undefined, {
      projectDir,
      userConfigDir,
      env: { ZKR_NETWORK: "mainnet" },
    })).network).toBe("mainnet");
    expect((await resolveConfiguredNetwork("testnet", {
      projectDir,
      userConfigDir,
      env: { ZKR_NETWORK: "mainnet" },
    })).network).toBe("testnet");
  });
});
