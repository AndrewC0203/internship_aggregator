import type { DiscoverySource } from "./types.js";

// ─── stub ─── see lever.ts. Ashby discovery is not implemented; typed placeholder only.
export const ashbyDiscovery: DiscoverySource = {
  source: "ashby",
  discoverCandidates() {
    throw new Error("ashby discovery not implemented");
  },
  fetchBoard() {
    throw new Error("ashby discovery not implemented");
  },
};
