import type { NormalizedListing } from "../types.js";

// ─── GATED (classification) ─── approach not yet decided; left as a stub.
//
// Intended (Decision 9): keep internships only. Cheap regex pass first, then AI model
// on the survivors. Regex must NOT be a lossy hard gate — it would drop co-ops and
// roles like "Summer 2026 Analyst Program" and false-positive on "Internal Tools".
export async function filterInternships(
  listings: NormalizedListing[],
): Promise<NormalizedListing[]> {
  throw new Error("filterInternships not implemented (GATED — decide classification approach)");
}
