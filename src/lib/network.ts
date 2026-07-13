import {
  loadZkrConfig,
  type LoadZkrConfigOptions,
} from "./config.js";

export type Network = "mainnet" | "testnet";

export interface NetworkConfig {
  network: Network;
  factoryAddress: string;
  tonAccessNetwork: "mainnet" | "testnet";
}

const MAINNET_FACTORY = "EQB8W1W276GWiQpK88Sx46K20rsMrCKIezOpwFGJ4dhjWz58";

const NETWORKS: Record<Network, Omit<NetworkConfig, "factoryAddress"> & { factoryAddress: string }> = {
  mainnet: {
    network: "mainnet",
    factoryAddress: MAINNET_FACTORY,
    tonAccessNetwork: "mainnet",
  },
  testnet: {
    network: "testnet",
    factoryAddress: "",
    tonAccessNetwork: "testnet",
  },
};

interface ResolveNetworkOptions {
  configuredNetwork?: Network;
  env?: Readonly<Record<string, string | undefined>>;
}

export function resolveNetwork(
  input: string | undefined,
  options: ResolveNetworkOptions = {},
): NetworkConfig {
  const env = options.env ?? process.env;
  const envNetwork = env.ZKR_NET ?? env.ZKR_NETWORK;
  const raw = (input ?? envNetwork ?? options.configuredNetwork ?? "mainnet").toLowerCase();
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`Invalid network "${raw}". Expected "mainnet" or "testnet".`);
  }
  return {
    ...NETWORKS[raw],
    factoryAddress: env.ZKR_FACTORY_ADDRESS ?? NETWORKS[raw].factoryAddress,
  };
}

export async function resolveConfiguredNetwork(
  input: string | undefined,
  options: LoadZkrConfigOptions = {},
): Promise<NetworkConfig> {
  const config = await loadZkrConfig(options);
  return resolveNetwork(input, {
    configuredNetwork: config.network,
    env: options.env ?? process.env,
  });
}
