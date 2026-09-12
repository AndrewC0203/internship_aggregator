import { prisma } from "./db.js";
import { enrichListings, formatEnrichSummary } from "./recommend/enrich.js";

// Standalone enrichment run (spec "Enrichment stage"): the same pass `npm run refresh`
// executes at its tail, runnable on its own for backfills and retries.
//
//   npm run enrich -- [--limit N]
//
//   --limit N   process at most N rows per sub-pass (smoke runs; omit for the full corpus).
//
// Safe to re-run and to interrupt: staleness is fingerprint/config-driven, so a re-run
// skips everything already current and picks up exactly what a crash left stale.
function parseArgs(argv: string[]): { limit?: number } {
  const args: { limit?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    if (flag === "--limit") {
      const n = Number(inlineValue ?? argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit expects a positive integer, got "${inlineValue ?? argv[i]}"`);
      }
      args.limit = n;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const { limit } = parseArgs(process.argv.slice(2));
  console.log(`[enrich] starting (${limit ? `limit ${limit}` : "full corpus"})...`);
  const summary = await enrichListings({ limit });
  console.log(`[enrich] done: ${formatEnrichSummary(summary)}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
