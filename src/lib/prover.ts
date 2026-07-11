import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  createPoseidon2,
  createSnarkjsProver,
  type Poseidon2,
  type Prover,
} from "@tonresistor/zkresistor-sdk";
import artifactManifest from "../../artifacts/circuits/manifest.json";
import { CliError } from "./errors.js";

type ArtifactName = keyof typeof artifactManifest.artifacts;

async function readVerifiedArtifact(
  name: ArtifactName,
  path: string,
): Promise<Buffer> {
  const expected = artifactManifest.artifacts[name];
  const bytes = await fs.readFile(path).catch(() => {
    throw new CliError(`Circuit artifact not found at ${path}`, {
      code: "ARTIFACT_NOT_FOUND",
      hint: `Restore the packaged ${expected.file} or set its documented ZKR_* path override.`,
    });
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== expected.bytes || sha256 !== expected.sha256) {
    throw new CliError(`Circuit artifact integrity check failed for ${path}`, {
      code: "ARTIFACT_INTEGRITY",
      details: {
        expected_bytes: expected.bytes,
        actual_bytes: bytes.byteLength,
        expected_sha256: expected.sha256,
        actual_sha256: sha256,
      },
    });
  }
  return bytes;
}

export async function loadPoseidon2(hasherWasmPath: string): Promise<Poseidon2> {
  const bytes = await readVerifiedArtifact("hasherWasm", hasherWasmPath);
  return createPoseidon2(new Uint8Array(bytes));
}

export async function loadInsertProver(opts: {
  wasm: string;
  zkey: string;
}): Promise<Prover> {
  const [wasm, zkey] = await Promise.all([
    readVerifiedArtifact("insertWasm", opts.wasm),
    readVerifiedArtifact("insertZkey", opts.zkey),
  ]);
  return createSnarkjsProver({ wasm, zkey });
}

export async function loadWithdrawProver(opts: {
  wasm: string;
  zkey: string;
}): Promise<Prover> {
  const [wasm, zkey] = await Promise.all([
    readVerifiedArtifact("withdrawWasm", opts.wasm),
    readVerifiedArtifact("withdrawZkey", opts.zkey),
  ]);
  return createSnarkjsProver({ wasm, zkey });
}
