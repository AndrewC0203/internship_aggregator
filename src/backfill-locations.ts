import { prisma } from "./db.js";
import { resolveLocation } from "./pipeline/stages/location.js";

// RE-RUNNABLE facet re-derive (Decision 19). Location facets are computed once at persist time
// and frozen — seenKeeps are never re-evaluated on later refreshes — so any resolver fix or
// dictionary widening leaves already-persisted rows with stale facets until this is re-run.
// (First need: the "Washington, D.C." fix, which was filing D.C. listings under WA.)
//
// Idempotent by construction: recompute resolveLocation() for every row, write only the rows
// whose stored arrays differ from the fresh result. Second run touches nothing.
async function main(): Promise<void> {
  const rows = await prisma.listing.findMany({
    select: {
      source: true,
      sourceExternalId: true,
      location: true,
      locCountries: true,
      locUsStates: true,
    },
  });

  let updated = 0;
  for (const row of rows) {
    const fresh = resolveLocation(row.location);
    const changed =
      fresh.countries.join(",") !== row.locCountries.join(",") ||
      fresh.usStates.join(",") !== row.locUsStates.join(",");
    if (!changed) continue;

    await prisma.listing.update({
      where: {
        source_sourceExternalId: {
          source: row.source,
          sourceExternalId: row.sourceExternalId,
        },
      },
      data: { locCountries: fresh.countries, locUsStates: fresh.usStates },
    });
    updated++;
    console.log(
      `"${row.location ?? ""}": [${row.locCountries}|${row.locUsStates}] -> ` +
        `[${fresh.countries}|${fresh.usStates}] (${row.source}:${row.sourceExternalId})`,
    );
  }

  console.log(`Backfill done: ${updated}/${rows.length} row(s) re-derived.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
