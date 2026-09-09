import { runDiscovery } from "./orchestrator.js";
import { prisma } from "../db.js";

// CLI entrypoint for the board discovery job:
//   `npm run discover -- [--source <name>] [--crawl <id>] [--limit <n>]`
//   --source <name>  run only this source (greenhouse | lever | ashby); default = all
//   --crawl <id>     specific Common Crawl crawl (e.g. CC-MAIN-2026-25); default = latest
//                    (lever: latest-with-signal — it walks back past CCBot-blocked crawls)
//   --limit <n>      cap the validation sweep to n candidates (default: uncapped)
interface CliArgs {
  crawlId?: string;
  limit?: number;
  source?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Support both "--flag value" and "--flag=value".
    const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    const value = inlineValue ?? argv[++i];
    if (flag === "--crawl") {
      args.crawlId = value;
    } else if (flag === "--source") {
      args.source = value;
    } else if (flag === "--limit") {
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
  const { crawlId, limit, source } = parseArgs(process.argv.slice(2));
  console.log(
    `Discovery run starting (${source ?? "all sources"}, ${crawlId ?? "latest crawl"}${limit ? `, limit ${limit}` : ", uncapped"})...`,
  );

  const summaries = await runDiscovery({ crawlId, limit, source });

  console.log("Done.");
  for (const s of summaries) {
    console.log(
      `  ${s.source}: discovered ${s.discovered}, processed ${s.processed}, ` +
        `kept ${s.kept}, dropped ${s.dropped}, errors ${s.errors}`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
