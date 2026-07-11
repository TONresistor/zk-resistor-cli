import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// Redirect CONFIG_DIR to a temp dir BEFORE importing the keystore module.
const TMP = mkdtempSync(join(tmpdir(), "zkr-test-"));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { writeKeystore, readKeystore, decryptKeystore, listKeystores } =
  await import("../src/lib/keystore.js");
const { CliError } = await import("../src/lib/errors.js");

describe("keystore round-trip", () => {
  beforeEach(() => {
    // Each test gets a fresh name; we never delete in test to keep things simple.
  });

  it("writes, reads, decrypts a mnemonic with the right passphrase", async () => {
    const mnemonic = "abandon ".repeat(23) + "abandon";
    const path = await writeKeystore({
      name: `t${Date.now()}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 32),
      address: "EQB8PZ-Cp6UzydbLvjukx1OQL3LmqeYV-tJ3qVMw_mNYgqow",
      payload: mnemonic,
      passphrase: "correct horse battery staple",
    });
    expect(path).toMatch(/wallets/);
    const ks = await readKeystore(path.split("/").pop()!.replace(".json", ""));
    const plain = await decryptKeystore(ks, "correct horse battery staple");
    expect(plain).toBe(mnemonic);
  });

  it("decryption fails with the wrong passphrase", async () => {
    const name = `tw${Date.now()}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
    await writeKeystore({
      name,
      address: "EQ0",
      payload: "secret stuff",
      passphrase: "right",
    });
    const ks = await readKeystore(name);
    await expect(decryptKeystore(ks, "wrong")).rejects.toThrow(CliError);
  });

  it("rejects invalid wallet names", async () => {
    await expect(
      writeKeystore({ name: "bad/name", address: "x", payload: "y", passphrase: "z12345678" }),
    ).rejects.toThrow(CliError);
  });

  it("lists stored wallets", async () => {
    const name = `tl${Date.now()}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
    await writeKeystore({ name, address: "EQ_listed", payload: "p", passphrase: "12345678" });
    const all = await listKeystores();
    expect(all.find((w) => w.name === name)).toBeDefined();
  });

  it("refuses overwrite by default, accepts with flag", async () => {
    const name = `to${Date.now()}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
    await writeKeystore({ name, address: "EQ1", payload: "p1", passphrase: "12345678" });
    await expect(
      writeKeystore({ name, address: "EQ2", payload: "p2", passphrase: "12345678" }),
    ).rejects.toThrow(/already exists/);
    await writeKeystore({
      name,
      address: "EQ2",
      payload: "p2",
      passphrase: "12345678",
      overwrite: true,
    });
    const ks = await readKeystore(name);
    expect(ks.address).toBe("EQ2");
  });
});
