import type { DiscoverySource } from "./types.js";

// ─── stub ─── Greenhouse is the only implemented discovery source for now (Decision 11).
// Kept as a typed placeholder so the orchestrator has a clear extension point; not wired
// into the SOURCES list until real. Fails loud rather than silently discovering nothing.
export const leverDiscovery: DiscoverySource = {
  source: "lever",
  discoverCandidates() {
    throw new Error("lever discovery not implemented");
  },
  fetchBoard() {
    throw new Error("lever discovery not implemented");
  },
};
