import { prisma } from "./db.js";
import { classify, extract } from "./model/classifier.js";
import { resolveLocation } from "./pipeline/stages/location.js";

// Re-run the CURRENT classify prompt against every active listing in the DB (Decision 18).
//
// Why this exists: prompt changes are not retroactive. Keeps live in `listings`, rejects in
// `seen_listings`, and neither is ever re-classified by the pipeline — so tightening the
// prompt (e.g. the Decision 16 IT help-desk split) only affects future unseen postings unless
// something re-evaluates the rows already kept. This command is that something. It only walks
// ACTIVE keeps: re-litigating past rejects would mean re-fetching content we never stored, and
// a tightened prompt can only shrink the keep set anyway.
//
// What a verdict does:
//   still a keep  -> update opportunityType + csField in place (lastSeenAt untouched — a
//                    reclassify is not a sighting, and faking one would corrupt freshness).
//   now a reject  -> DELIST, don't delete: isListed=false keeps the row as an auditable record
//                    of what the old prompt kept (unlike pipeline rejects, which are key-only
//                    by design, this content is already paid for), and a seen_listings row
//                    stops the next crawl from re-classifying it. partitionBySeen checks
//                    reject-memory FIRST for exactly this row-in-both-tables state — without
//                    that ordering, persist()'s seenKeep path would resurrect the row.
//                    Reversal is manual but cheap: delete the seen_listings row and set
//                    isListed=true, or loosen the prompt and delete the seen_listings row to
//                    let the next crawl re-evaluate it fresh.
//
// Flags (remember npm needs `--`: `npm run reclassify -- --dry-run`):
//   --dry-run   log every would-be change, write nothing. Run this first after a prompt edit.
//   --extract   also re-run the extraction pass (grad dates / citizenship) on listings that
//               stay kept. Off by default: it doubles model time, and is only needed when the
//               EXTRACT prompt/schema changed (e.g. Decision 17's grad-date backfill).
//   --limit N   only process the first N listings (a cheap smoke run before the full sweep).
//
// Sequential like every other model loop in this repo: one local Ollama, one request at a
// time. ~495 actives ≈ 30 min classify-only, ~60 min with --extract, on the 7B.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const withExtract = args.includes("--extract");
  const limitIdx = args.findIndex((a) => a === "--limit" || a.startsWith("--limit="));
  const limit =
    limitIdx === -1
      ? undefined
      : Number(args[limitIdx].includes("=") ? args[limitIdx].split("=")[1] : args[limitIdx + 1]);
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new Error("--limit needs an integer, e.g. --limit 20");
  }

  // id order so an interrupted run can be reasoned about ("it got through id X") and re-runs
  // are deterministic. Re-running is safe: keep-verdict updates are idempotent, and already-
  // delisted rows are excluded by the isListed filter.
  const listings = await prisma.listing.findMany({
    where: { isListed: true },
    orderBy: { id: "asc" },
    take: limit,
  });

  console.log(
    `[reclassify] ${listings.length} active listings${dryRun ? " (DRY RUN — no writes)" : ""}` +
      `${withExtract ? " (with re-extract)" : ""}`,
  );

  let kept = 0;
  let retyped = 0;
  let delisted = 0;
  let failed = 0;

  for (const [i, row] of listings.entries()) {
    const label = `[reclassify ${i + 1}/${listings.length}] ${row.company} :: "${row.title}"`;
    try {
      const verdict = await classify(row);
      const stillKeep = verdict.csRelevant && verdict.opportunityType !== null;

      if (!stillKeep) {
        delisted++;
        console.log(`${label} -> DELIST (csRelevant=${verdict.csRelevant})`);
        if (!dryRun) {
          // Atomic pair: a delisted row without its seen_listings key would be resurrected
          // (as a seenKeep) by the next crawl, so never let one write land without the other.
          await prisma.$transaction([
            prisma.listing.update({
              where: { id: row.id },
              data: { isListed: false },
            }),
            prisma.seenListing.upsert({
              where: {
                source_sourceExternalId: {
                  source: row.source,
                  sourceExternalId: row.sourceExternalId,
                },
              },
              create: { source: row.source, sourceExternalId: row.sourceExternalId },
              update: {}, // key already recorded; nothing to change (not a sighting)
            }),
          ]);
        }
        continue;
      }

      kept++;
      const typeChanged =
        verdict.opportunityType !== row.opportunityType || verdict.csField !== row.csField;
      if (typeChanged) {
        retyped++;
        console.log(
          `${label} -> keep (${row.opportunityType}/${row.csField ?? "-"} => ` +
            `${verdict.opportunityType}/${verdict.csField ?? "-"})`,
        );
      }

      // Re-extract only on request (see --extract above). applicationDeadline is deliberately
      // fill-if-null: an existing value may be Greenhouse's structured field, which beats an
      // extracted guess (Decision 7) — and the DB can't tell us which origin it was.
      const extracted = withExtract ? await extract(row) : null;

      // Location facets (Decision 19) ride every keep-verdict write unconditionally — the
      // parser is pure code (no model call, microseconds), so there's no reason to gate the
      // backfill behind --extract. This is what backfills pre-Decision-19 rows.
      const loc = resolveLocation(row.location);

      if (!dryRun) {
        await prisma.listing.update({
          where: { id: row.id },
          data: {
            opportunityType: verdict.opportunityType,
            csField: verdict.csField,
            locCountries: loc.countries,
            locUsStates: loc.usStates,
            ...(extracted && {
              gradDateMin: extracted.gradDateMin,
              gradDateMax: extracted.gradDateMax,
              gradYearMin: extracted.gradYearMin,
              gradYearMax: extracted.gradYearMax,
              citizenshipStatus: extracted.citizenshipStatus,
              applicationDeadline: row.applicationDeadline ?? extracted.applicationDeadline,
            }),
          },
        });
      }
    } catch (err) {
      // Same isolation rule as the pipeline loops: a transient model failure skips this row
      // (its old classification simply stands) and the sweep continues.
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${label} -> SKIPPED (model error, old classification stands): ${reason}`);
    }
  }

  console.log(
    `[reclassify] done${dryRun ? " (dry run)" : ""}: ${kept} kept ` +
      `(${retyped} re-typed), ${delisted} delisted, ${failed} skipped on error.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
