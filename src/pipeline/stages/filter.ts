import type { NormalizedListing, ClassifiedListing, ListingKey } from "../types.js";
import { acceptRoute } from "./accept-router.js";
import { rejectRoute } from "./reject-router.js";
import { minYearsExperience } from "./experience.js";
import { classify } from "../../model/classifier.js";

export interface FilterResult {
  keeps: ClassifiedListing[]; // CS-adjacent + in-scope; carry their classified opportunity_type
  newRejects: ListingKey[]; // dropped by the MODEL; only their key flows on (→ seen_listings)
  titleDropped: number; // dropped by the reject-router (title); NOT persisted anywhere
  yoeDropped: number; // dropped by the experience filter (body); NOT persisted anywhere
}

// The MVP experience policy (Decision 14): keep only postings that state no experience
// minimum at all, or state one of 0 years. A posting asking for 1+ years is dropped.
//
// This is the POLICY; experience.ts holds the parsing. Deliberately a constant rather than a
// config knob — v1 is where a configurable cutoff and a stored years_experience column belong
// (see FEATURES.md). Raising this number is a one-line change that retroactively re-evaluates
// everything previously dropped, because these drops are never recorded.
const MAX_YEARS_EXPERIENCE = 0;

// Filter stage (Decisions 12–14): four tiers, cheapest first.
//   1. accept-router     — unambiguous CS internships/co-ops, kept without a model call
//   2. reject-router     — unambiguously out-of-scope TITLES, dropped without a model call
//   3. experience filter — postings stating an experience minimum, dropped without a model call
//   4. the model         — everything genuinely ambiguous
//
// Runs only on listings the partition step deemed unseen, so this is where the initial-run
// cost lives. Tiers 2 and 3 are the volume levers: measured on real postings, the title router
// removes ~82% of listings and the experience filter removes ~61% of what survives it, taking
// model calls to ~39% of the titles that used to reach it (research/yoe-filter-analysis.md).
//
// Keeps carry their opportunity_type (from the router or the model). Only MODEL rejects
// contribute a key to newRejects — see the regex-drop note in the loop for why.
export async function filterInternships(
  listings: NormalizedListing[],
): Promise<FilterResult> {
  const keeps: ClassifiedListing[] = [];
  const newRejects: ListingKey[] = [];
  let titleDropped = 0;
  let yoeDropped = 0;

  // Per-listing failure isolation, mirroring the orchestrator's per-board try/catch: one
  // model failure (Ollama OOM/500/timeout on a pathological input) skips just that listing
  // and the run continues to persist.
  //
  // Crucial: on failure we do NOT record it as a reject. seen_listings is key-only and
  // never re-checked, so writing a reject here would PERMANENTLY drop a listing over a
  // TRANSIENT error. Skipping without recording leaves it unseen, so the next run retries it.
  //
  // Sequential on purpose: a single local Ollama instance serves one request at a time, so
  // firing these in parallel just queues them (and risks OOM on a big model).
  for (const [i, listing] of listings.entries()) {
    try {
      // Tier 1 runs BEFORE the experience filter on purpose. An explicit "Software
      // Engineering Intern" is an internship whatever its body says, and at a cutoff of 0
      // years an incidental "1 year program" in the description would otherwise drop a
      // genuine internship. The accept-router is high-precision, so letting it win is safe.
      const routed = acceptRoute(listing.title);
      if (routed) {
        keeps.push({ ...listing, opportunityType: routed });
        console.log(`[classify ${i + 1}/${listings.length}] router-accepted: "${listing.title}"`);
        continue;
      }

      // Tier 2: unambiguously out of scope — drop WITHOUT a model call.
      //
      // Crucially, this does NOT push to newRejects, so nothing is written to seen_listings.
      // The regex is free and deterministic, so memoizing it would save nothing next run,
      // while making the drop permanent and unauditable (seen_listings is key-only and
      // partitionBySeen never re-checks it). Leaving it unrecorded means a fix to
      // reject-router.ts retroactively recovers the listing on the next run.
      if (rejectRoute(listing.title)) {
        titleDropped++;
        continue;
      }

      // Tier 3: the posting states an experience minimum above our cutoff — drop it WITHOUT a
      // model call. Same not-recorded rule as tier 2, and for the same reason.
      //
      // This exists because the model reads the title and under-weights this exact line: it
      // kept "Researcher" (2+ years UX) and "Data Analyst" (2+ years analytics) as
      // early-career. A regex reading the body is both cheaper and, on this signal, more
      // reliable than the 7B model — the number is stated explicitly, so there is nothing to
      // infer. `null` means the posting states no minimum, which is NOT a reason to drop it.
      const minYears = minYearsExperience(listing.descriptionPlain);
      if (minYears !== null && minYears > MAX_YEARS_EXPERIENCE) {
        yoeDropped++;
        continue;
      }

      // Per-listing progress (the AI call is the slow part — seconds per listing on a local
      // model — so silence here reads as "hung" even when it's working normally). Only the
      // listings that survive both routers get a line, which keeps the log readable now that
      // the reject-router removes the bulk of them silently.
      console.log(`[classify ${i + 1}/${listings.length}] calling model: "${listing.title}"...`);
      const { csRelevant, opportunityType } = await classify(listing);
      if (csRelevant && opportunityType) {
        keeps.push({ ...listing, opportunityType });
        console.log(`[classify ${i + 1}/${listings.length}] KEEP (${opportunityType})`);
      } else {
        newRejects.push({
          source: listing.source,
          sourceExternalId: listing.sourceExternalId,
        });
        console.log(`[classify ${i + 1}/${listings.length}] reject`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `Skipping classify for ${listing.source} "${listing.sourceExternalId}" (will retry next run): ${reason}`,
      );
    }
  }

  console.log(
    `[filter] ${listings.length} unseen -> ${titleDropped} title-dropped, ` +
      `${yoeDropped} experience-dropped (no model call), ` +
      `${keeps.length} keeps, ${newRejects.length} model-rejects`,
  );

  return { keeps, newRejects, titleDropped, yoeDropped };
}
