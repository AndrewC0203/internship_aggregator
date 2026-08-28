import { runPipeline } from "./pipeline/orchestrator.js";
import { prisma } from "./db.js";

// CLI entrypoint for the ingestion refresh: `npm run refresh -- [--limit <n>] [--full]`
//   --limit <n>   cap boards per source (use a small n for a first smoke-test run;
//                 omit for a full refresh of every active crawl_target)
//   --full        ignore stored etags and re-download every board (Decision 23). Needed
//                 when stored rows must be REBUILT from bodies an unchanged-board 304
//                 would skip — e.g. after fixing a normalize bug.
//
// Mirrors src/discovery/run.ts. Reads active crawl_targets, fetches + normalizes + dedups +
// partitions + classifies + extracts + persists (Decisions 9–12).
interface CliArgs {
  limit?: number;
  full?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Support both "--flag value" and "--flag=value".
    const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    if (flag === "--full") {
      args.full = true;
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (flag === "--limit") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit expects a positive integer, got "${value}"`);
      }
      args.limit = n;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const { limit, full } = parseArgs(process.argv.slice(2));
  console.log(
    `Refresh run starting (${limit ? `limit ${limit} board(s) per source` : "all active boards"}` +
      `${full ? ", full re-download — etags ignored" : ""})...`,
  );

  await runPipeline({ limit, full });

  console.log("Done.");
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
