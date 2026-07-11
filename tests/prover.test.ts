import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadZkrConfig } from "../src/lib/config.js";
import {
  loadInsertProver,
  loadPoseidon2,
  loadWithdrawProver,
} from "../src/lib/prover.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zkr-prover-test-"));
  tempDirs.push(path);
  return path;
}

describe("packaged circuit artifacts", () => {
  it("loads every default artifact after checking its frozen integrity", async () => {
    const root = await tempDir();
    const cfg = await loadZkrConfig({
      projectDir: root,
      userConfigDir: root,
      env: {},
    });

    const [poseidon2, insertProver, withdrawProver] = await Promise.all([
      loadPoseidon2(cfg.hasherWasm),
      loadInsertProver({ wasm: cfg.insertWasm, zkey: cfg.insertZkey }),
      loadWithdrawProver({ wasm: cfg.withdrawWasm, zkey: cfg.withdrawZkey }),
    ]);

    expect(await poseidon2(0n, 0n)).toBe(
      51576823595707970152643159819788304363803754756066229172775779360774743019614n,
    );
    expect(insertProver).toBeTypeOf("function");
    expect(withdrawProver).toBeTypeOf("function");
  });

  it("distinguishes missing artifacts from corrupt artifacts", async () => {
    const root = await tempDir();
    const missing = join(root, "missing.wasm");
    const corrupt = join(root, "corrupt.wasm");
    await writeFile(corrupt, Buffer.from([0]));

    await expect(loadPoseidon2(missing)).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
    await expect(loadPoseidon2(corrupt)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY",
      details: { expected_bytes: 964_886, actual_bytes: 1 },
    });
  });
});
