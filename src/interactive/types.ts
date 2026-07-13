import type { Network } from "../lib/network.js";

export type ExecuteCommand = (rawArgs: string[]) => Promise<void>;

export interface InteractiveSession {
  network: Network;
  wallet?: string;
}

export interface StoredWallet {
  name: string;
  address: string;
}
