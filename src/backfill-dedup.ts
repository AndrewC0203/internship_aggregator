import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { dedupKey, unionKeys, parseDuplicateKeys } from "./pipeline/stages/dedup.js";

// ONE-TIME backfill (Decision 15). dedup() only stops NEW duplicates from being written going
// forward — every row already in `listings` from before this feature existed already has its
// own ID, so a fresh refresh's dedup() always hits the `isSelf` branch for them and leaves them
// untouched. This script applies the exact same (company, title, location) key to the rows that
// already exist, once, to collapse the currently-measured 21% down to reality.
//
// Same rule as Decision 9's write-time handling: DEACTIVATE the losers (isListed = false), never
// hard-delete, and fold their keys into the survivor's duplicateKeys array. The survivor is
// chosen the same deterministic way dedup() picks one (smallest sourceExternalId), so re-running
// this script is idempotent — a group already collapsed has only one active row left, so it's a
// group of one and nothing happens.
async function main(): Promise<void> {
  const active = await prisma.listing.findMany({
    where: { isListed: true },
    select: {
      source: true,
      sourceExternalId: true,
      company: true,
      title: true,
      location: true,
      duplicateKeys: true,
    },
  });

  const groups = new Map<string, typeof active>();
  for (const row of active) {
    const k = dedupKey(row);
    const arr = groups.get(k) ?? [];
    arr.push(row);
    groups.set(k, arr);
  }

  let collapsedGroups = 0;
  let deactivated = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const [survivor, ...losers] = [...group].sort((a, b) =>
      a.sourceExternalId.localeCompare(b.sourceExternalId),
    );

    const mergedKeys = unionKeys(
      parseDuplicateKeys(survivor.duplicateKeys),
      losers.map((l) => ({ source: l.source, sourceExternalId: l.sourceExternalId })),
    );

    await prisma.listing.update({
      where: {
        source_sourceExternalId: {
          source: survivor.source,
          sourceExternalId: survivor.sourceExternalId,
        },
      },
      data: { duplicateKeys: mergedKeys as unknown as Prisma.InputJsonValue },
    });

    for (const loser of losers) {
      await prisma.listing.update({
        where: {
          source_sourceExternalId: {
            source: loser.source,
            sourceExternalId: loser.sourceExternalId,
          },
        },
        data: { isListed: false },
      });
    }

    collapsedGroups++;
    deactivated += losers.length;
    console.log(
      `Collapsed "${survivor.company} :: ${survivor.title}" (${survivor.location ?? "no location"}): ` +
        `kept ${survivor.sourceExternalId}, deactivated ${losers.map((l) => l.sourceExternalId).join(", ")}`,
    );
  }

  console.log(
    `Backfill done: ${collapsedGroups} group(s) collapsed, ${deactivated} row(s) deactivated ` +
      `(kept, not deleted — Decision 9).`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
