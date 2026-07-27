import type { NormalizedListing, ClassifiedListing, ListingKey } from "../types.js";
import { acceptRoute } from "./accept-router.js";
import { classify } from "../../model/classifier.js";

export interface FilterResult {
  keeps: ClassifiedListing[]; // CS-adjacent + in-scope; carry their classified opportunity_type
  newRejects: ListingKey[]; // dropped; only their key flows on (→ seen_listings via persist)
}

// Filter stage (Decision 12): cheap regex accept-router first, AI classify for the rest.
// Runs only on listings the partition step deemed unseen, so this is where the initial-run
// cost lives. Keeps carry their opportunity_type (from the router or the model); rejects
// contribute only their key so they can be remembered and skipped next run — no non-CS
// content is ever kept.
export async function filterInternships(
  listings: NormalizedListing[],
): Promise<FilterResult> {
  const keeps: ClassifiedListing[] = [];
  const newRejects: ListingKey[] = [];

  // Sequential on purpose: a single local Ollama instance serves one request at a time, so
  // firing these in parallel just queues them (and risks OOM on a big model). A batch job
  // doesn't need the concurrency.
  for (const listing of listings) {
    const routed = acceptRoute(listing.title);
    if (routed) {
      keeps.push({ ...listing, opportunityType: routed });
      continue;
    }

    const { csRelevant, opportunityType } = await classify(listing);
    if (csRelevant && opportunityType) {
      keeps.push({ ...listing, opportunityType });
    } else {
      newRejects.push({
        source: listing.source,
        sourceExternalId: listing.sourceExternalId,
      });
    }
  }

  return { keeps, newRejects };
}
