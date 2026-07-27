import type { ClassifiedListing, EnrichedListing } from "../types.js";
import { extract as extractFields } from "../../model/classifier.js";

// Extract stage (Pass 2, Decision 12): pull grad year / citizenship / deadline from
// description_plain for KEEPS only (extraction never runs on rejects, which is why two
// passes cost almost nothing extra). Greenhouse's structured application_deadline — if the
// normalizer set it — wins over an extracted one (Decision 7); otherwise the extracted value
// fills the gap.
export async function extract(
  listings: ClassifiedListing[],
): Promise<EnrichedListing[]> {
  const enriched: EnrichedListing[] = [];

  // Sequential for the same reason as the classify pass: one local model, one request at a time.
  for (const listing of listings) {
    const fields = await extractFields(listing);
    enriched.push({
      ...listing,
      gradYearMin: fields.gradYearMin,
      gradYearMax: fields.gradYearMax,
      citizenshipStatus: fields.citizenshipStatus,
      applicationDeadline: listing.applicationDeadline ?? fields.applicationDeadline,
    });
  }

  return enriched;
}
