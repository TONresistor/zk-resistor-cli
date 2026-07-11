import { Address } from "@ton/core";
import {
  Factory,
  Pool,
  buildInitWalletBinding,
  type BuiltMessage,
  type Client,
} from "@tonresistor/zkresistor-sdk";

export interface PoolActivationPlan {
  status: "pending" | "active";
  message: BuiltMessage | null;
  jettonMaster: string;
  denomination: bigint;
  walletBound: boolean;
}

function sameAddress(left: string, right: string): boolean {
  return Address.parse(left).equals(Address.parse(right));
}

export function buildPoolActivationMessage(
  poolAddress: string,
  queryId?: bigint,
  walletBound = false,
) {
  return buildInitWalletBinding({ poolAddress, queryId, walletBound });
}

/** Fail closed unless the target is the selected Factory's registered Jetton Pool. */
export async function planPoolActivation(
  client: Client,
  factoryAddress: string,
  poolAddress: string,
  queryId?: bigint,
): Promise<PoolActivationPlan> {
  let actualFactory: string;
  let jettonMaster: string;
  let denomination: bigint;
  let jettonWallet: string | null;
  try {
    [actualFactory, jettonMaster, denomination, jettonWallet] = await Promise.all([
      Pool.readFactory(client, poolAddress),
      Pool.readJettonMaster(client, poolAddress),
      Pool.readDenomination(client, poolAddress),
      Pool.readJettonWallet(client, poolAddress),
    ]);
  } catch (error) {
    throw new Error("Activation target is not an active Jetton Pool", { cause: error });
  }
  if (!sameAddress(actualFactory, factoryAddress)) {
    throw new Error("Activation target belongs to another Factory");
  }
  const registered = await Factory.poolAddressFor(
    client,
    factoryAddress,
    jettonMaster,
    denomination,
  );
  if (registered === null || !sameAddress(registered, poolAddress)) {
    throw new Error("Activation target is not registered by the selected Factory");
  }
  const pending = await Factory.poolDeploymentPending(
    client,
    factoryAddress,
    jettonMaster,
    denomination,
  );
  const walletBound = jettonWallet !== null;
  return {
    status: pending ? "pending" : "active",
    message: pending
      ? buildPoolActivationMessage(poolAddress, queryId, walletBound)
      : null,
    jettonMaster,
    denomination,
    walletBound,
  };
}
