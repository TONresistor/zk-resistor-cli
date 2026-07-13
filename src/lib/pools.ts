import {
  Factory,
  type Client,
  type PoolInfo,
} from "@tonresistor/zkresistor-sdk";
import { makeSdkClient, makeTonClient } from "./client.js";
import { formatPoolDenomination } from "./format.js";
import {
  resolveConfiguredNetwork,
  type NetworkConfig,
} from "./network.js";

export type PoolCategory = "all" | PoolInfo["kind"];

export interface PoolCatalog {
  network: NetworkConfig;
  client: Client;
  pools: PoolInfo[];
}

export async function loadPoolCatalog(network?: string): Promise<PoolCatalog> {
  const resolved = await resolveConfiguredNetwork(network);
  const client = makeSdkClient(await makeTonClient(resolved));
  const pools = await Factory.listPools(client, resolved.factoryAddress);
  return { network: resolved, client, pools };
}

export function filterPools(
  pools: readonly PoolInfo[],
  category: PoolCategory,
  query = "",
): PoolInfo[] {
  const needle = query.trim().toLowerCase();
  return pools.filter((pool) => {
    if (category !== "all" && pool.kind !== category) return false;
    if (needle.length === 0) return true;
    const searchable = [
      pool.poolAddress,
      pool.kind,
      pool.denomination.toString(),
      formatPoolDenomination(pool),
      ...(pool.kind === "jetton"
        ? [
            pool.jettonMaster,
            pool.jettonSymbol,
            pool.jettonName ?? "",
            pool.jettonWallet ?? "",
          ]
        : []),
    ];
    return searchable.some((value) => value.toLowerCase().includes(needle));
  });
}
