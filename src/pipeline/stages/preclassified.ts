import type { NormalizedListing, EnrichedListing } from "../types.js";

// Pre-classified bypass (Decision 38). A curated feed's entries carry no description, so the
// AI filter (classify) and extract passes have literally nothing to read — and the feed's
// human curation is a stronger verdict than a title-only model call could be. Listings whose
// normalize() attached `preclassified` skip both AI stages: the source's verdict becomes the
// enriched row directly, with every AI-extracted field null (absence is not a statement —
// same rule as a failed extract, see extract.ts's catch branch).
//
// Runs on the UNSEEN partition only (like filter/extract), so a pre-classified listing still
// gets dedup'd, partitioned, and — once persisted — refreshed through the ordinary seenKeep
// path. The `preclassified` marker is consumed here (destructured away): it is pipeline
// routing metadata, not row data, and persist() spreads listings straight into Prisma writes.
export function splitPreclassified(listings: NormalizedListing[]): {
  pre: EnrichedListing[];
  rest: NormalizedListing[];
} {
  const pre: EnrichedListing[] = [];
  const rest: NormalizedListing[] = [];

  for (const listing of listings) {
    const { preclassified, ...row } = listing;
    if (!preclassified) {
      rest.push(listing);
      continue;
    }
    pre.push({
      ...row,
      opportunityType: preclassified.opportunityType,
      csField: preclassified.csField,
      citizenshipStatus: preclassified.citizenshipStatus,
      gradDateMin: null,
      gradDateMax: null,
      gradYearMin: null,
      gradYearMax: null,
      degreeStatus: null,
    });
  }

  return { pre, rest };
}
