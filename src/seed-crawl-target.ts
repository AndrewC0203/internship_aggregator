import type { Source } from "@prisma/client";
import { prisma } from "./db.js";

// Manually seeds ONE crawl_targets row for local smoke-testing a source that has no real
// discovery mechanism wired up yet (Lever/Ashby — see FEATURES.md's "STILL BLOCKED" note on
// the Lever adapter). NOT how boards get discovered in production — `npm run discover` is the
// real path once a source has one; this is a dev-only stand-in scoped to a single board.
//
// Usage: `npx tsx src/seed-crawl-target.ts <source> <token>`
//   e.g. `npx tsx src/seed-crawl-target.ts lever palantir`
const VALID_SOURCES: Source[] = ["greenhouse", "lever", "ashby", "other"];

async function main(): Promise<void> {
  const [sourceArg, token] = process.argv.slice(2);
  if (!sourceArg || !token) {
    throw new Error("Usage: npx tsx src/seed-crawl-target.ts <source> <token>");
  }
  if (!VALID_SOURCES.includes(sourceArg as Source)) {
    throw new Error(`Unknown source "${sourceArg}" — expected one of: ${VALID_SOURCES.join(", ")}`);
  }
  const source = sourceArg as Source;

  // Same upsert shape as discovery's own (src/discovery/orchestrator.ts) — isActive is left
  // untouched on update since reactivation/pruning policy is still undecided there too.
  const target = await prisma.crawlTarget.upsert({
    where: { source_token: { source, token } },
    create: { source, token },
    update: { lastSeenInDiscoveryAt: new Date() },
  });

  console.log(
    `Seeded crawl_target: ${target.source}/${target.token} ` +
      `(id=${target.id}, active=${target.isActive})`,
  );
  console.log(
    `Note: "npm run refresh" pulls ALL active crawl_targets across every source, not just ` +
      `this one — see the README's Commands table for scoping it with --limit before running.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
