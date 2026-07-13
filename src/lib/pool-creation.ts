import {
  Factory,
  buildCreatePool,
  buildCreateTonPool,
  type BuiltMessage,
  type Client,
} from "@tonresistor/zkresistor-sdk";
import { CliError } from "./errors.js";

export interface PoolCreationPlan {
  poolAddress: string;
  message: BuiltMessage;
}

export async function planJettonPoolCreation(
  client: Client,
  factoryAddress: string,
  jettonMaster: string,
  denomination: bigint,
): Promise<PoolCreationPlan> {
  if (denomination <= 0n) {
    throw new CliError("Denomination must be positive.", { code: "INVALID_ARG" });
  }
  const message = buildCreatePool({
    factoryAddress,
    jettonMaster,
    denomination,
  });
  const [pending, existing, expected] = await Promise.all([
    Factory.poolDeploymentPending(client, factoryAddress, jettonMaster, denomination),
    Factory.poolAddressFor(client, factoryAddress, jettonMaster, denomination),
    Factory.expectedPoolAddress(client, factoryAddress, jettonMaster, denomination),
  ]);
  if (pending) {
    throw new CliError("Creation of this Jetton Pool is already in flight.", {
      code: "POOL_CREATION_PENDING",
      details: { pool: expected },
    });
  }
  if (existing !== null) {
    throw new CliError("This Jetton denomination already has a Pool.", {
      code: "POOL_ALREADY_EXISTS",
      details: { pool: existing },
    });
  }
  return {
    poolAddress: expected,
    message,
  };
}

export async function planTonPoolCreation(
  client: Client,
  factoryAddress: string,
  denomination: bigint,
): Promise<PoolCreationPlan> {
  const message = buildCreateTonPool({ factoryAddress, denomination });
  const [pending, existing, expected] = await Promise.all([
    Factory.tonPoolDeploymentPending(client, factoryAddress, denomination),
    Factory.tonPoolAddressFor(client, factoryAddress, denomination),
    Factory.expectedTonPoolAddress(client, factoryAddress, denomination),
  ]);
  if (pending) {
    throw new CliError("Creation of this GRAM Pool is already in flight.", {
      code: "POOL_CREATION_PENDING",
      details: { pool: expected },
    });
  }
  if (existing !== null) {
    throw new CliError("This GRAM denomination already has a Pool.", {
      code: "POOL_ALREADY_EXISTS",
      details: { pool: existing },
    });
  }
  return {
    poolAddress: expected,
    message,
  };
}
