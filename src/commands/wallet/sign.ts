import { defineCommand } from "citty";
import { sign } from "@ton/crypto";
import { Cell } from "@ton/core";
import { emit } from "../../lib/output.js";
import { CliError } from "../../lib/errors.js";
import { outputArgs } from "../../lib/args.js";
import { unlockWallet } from "../../lib/wallet.js";
import { readStdin } from "../../lib/input.js";

export default defineCommand({
  meta: {
    name: "sign",
    description: "Sign an arbitrary body cell with the wallet's private key (64-byte Ed25519). Off-chain only.",
  },
  args: {
    ...outputArgs,
    name: {
      type: "positional",
      description: "Wallet name.",
      required: true,
    },
    body: {
      type: "string",
      description: "Cell BOC to sign (hex or base64). If omitted, reads from stdin.",
    },
  },
  async run({ args }) {
    const bodyRaw =
      args.body ??
      (!process.stdin.isTTY
        ? await readStdin()
        : (() => {
            throw new CliError("No body provided.", {
              code: "INVALID_ARG",
              hint: "Pass --body <hex|base64> or pipe to stdin.",
            });
          })());

    const cell = parseBocAny(bodyRaw.trim());
    const loaded = await unlockWallet({ name: args.name });
    const signature = sign(cell.hash(), loaded.keyPair.secretKey);

    emit(
      {
        address: loaded.address,
        body_hash_hex: cell.hash().toString("hex"),
        signature_hex: Buffer.from(signature).toString("hex"),
      },
      args,
      () => {
        process.stdout.write(Buffer.from(signature).toString("hex") + "\n");
      },
    );
  },
});

function parseBocAny(s: string): Cell {
  if (/^(0x)?[0-9a-f]+$/i.test(s)) {
    const hex = s.startsWith("0x") ? s.slice(2) : s;
    const cell = parseHexBoc(hex);
    if (cell !== null) return cell;
  }
  try {
    return Cell.fromBase64(s);
  } catch {
    throw new CliError("Could not parse body as hex or base64 BOC.", { code: "INVALID_ARG" });
  }
}

function parseHexBoc(hex: string): Cell | null {
  try {
    return Cell.fromBoc(Buffer.from(hex, "hex"))[0] ?? null;
  } catch {
    return null;
  }
}
