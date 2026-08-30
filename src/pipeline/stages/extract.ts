import type { ClassifiedListing, EnrichedListing } from "../types.js";
import { extract as extractFields } from "../../model/classifier.js";

// Extract stage (Pass 2, Decision 12): pull grad year / citizenship / deadline from
// description_plain for KEEPS only. Greenhouse's structured application_deadline — if the
// normalizer set it — wins over an extracted one (Decision 7); otherwise the extracted value
// fills the gap.
export async function extract(
  listings: ClassifiedListing[],
): Promise<EnrichedListing[]> {
  const enriched: EnrichedListing[] = [];

  // Per-listing failure isolation (same rationale as the classify stage). But note the
  // different recovery: this listing is ALREADY a validated keep, so on extract failure we
  // still persist it — just with null extracted fields — rather than dropping it. That
  // preserves the classification work already paid for. (applicationDeadline is carried from
  // the normalized listing via the spread, so a structured Greenhouse deadline survives.)
  //
  // Sequential for the same reason as classify: one local model, one request at a time.
  for (const [i, listing] of listings.entries()) {
    try {
      // Progress log — the AI call is the slow part, so silence here reads as "hung."
      console.log(`[extract ${i + 1}/${listings.length}] calling model: "${listing.title}"...`);
      const fields = await extractFields(listing);
      enriched.push({
        ...listing,
        gradDateMin: fields.gradDateMin,
        gradDateMax: fields.gradDateMax,
        gradYearMin: fields.gradYearMin,
        gradYearMax: fields.gradYearMax,
        citizenshipStatus: fields.citizenshipStatus,
        degreeStatus: fields.degreeStatus,
        applicationDeadline: listing.applicationDeadline ?? fields.applicationDeadline,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `Extract failed for ${listing.source} "${listing.sourceExternalId}" — keeping listing without extracted fields: ${reason}`,
      );
      enriched.push({
        ...listing,
        gradDateMin: null,
        gradDateMax: null,
        gradYearMin: null,
        gradYearMax: null,
        citizenshipStatus: null,
        degreeStatus: null,
      });
    }
  }

  return enriched;
}
