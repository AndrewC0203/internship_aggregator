import { prisma } from "../db.js";
import type { DiscoveryOptions, DiscoverySource } from "./types.js";
import { greenhouseDiscovery } from "./greenhouse.js";
import { validateToken } from "./validate.js";

export interface DiscoverySummary {
  source: string;
  discovered: number; // unique candidate tokens from Common Crawl (before any cap)
  processed: number; // how many we actually validated (after --limit cap)
  kept: number; // validated live -> upserted as targets
  dropped: number; // 404 / empty board -> not a target
  errors: number; // transient failures skipped this run
}

// Only Greenhouse is implemented; Lever/Ashby discovery stubs exist but aren't wired in
// until real — mirrors how the ingestion orchestrator leaves their fetch/normalize stubbed.
const SOURCES: DiscoverySource[] = [greenhouseDiscovery];

export interface RunOptions extends DiscoveryOptions {
  // Cap the validation sweep. Until the GATED rate-limiting decision is made, a full
  // multi-thousand-token sweep against the live ATS is intentionally not run unattended.
  limit?: number;
}

export async function runDiscovery(opts: RunOptions = {}): Promise<DiscoverySummary[]> {
  const summaries: DiscoverySummary[] = [];

  for (const src of SOURCES) {
    // targetCount lets discovery stop paging Common Crawl early on a capped run.
    const discovered = await src.discoverCandidates({
      crawlId: opts.crawlId,
      targetCount: opts.limit,
    });

    const processed = opts.limit ? discovered.slice(0, opts.limit) : discovered;
    if (opts.limit && discovered.length > opts.limit) {
      console.error(
        `  [${src.source}] capping validation at ${opts.limit}/${discovered.length} candidates ` +
          `(--limit; a full sweep needs the GATED rate-limit decision first)`,
      );
    }

    const summary: DiscoverySummary = {
      source: src.source,
      discovered: discovered.length,
      processed: processed.length,
      kept: 0,
      dropped: 0,
      errors: 0,
    };

    for (const token of processed) {
      const outcome = await validateToken(token, src.fetchBoard);
      if (outcome === "valid") {
        // Upsert on the (source, token) natural key: a re-run refreshes the discovery
        // timestamp instead of duplicating. isActive is left untouched on update —
        // reactivation/pruning policy is FIRST-DRAFT-MINE and not decided here.
        await prisma.crawlTarget.upsert({
          where: { source_token: { source: src.source, token } },
          create: { source: src.source, token },
          update: { lastSeenInDiscoveryAt: new Date() },
        });
        summary.kept++;
      } else if (outcome === "empty") {
        summary.dropped++;
      } else {
        summary.errors++;
        console.error(`  [${src.source}] transient error validating "${token}" — skipped this run`);
      }
    }

    summaries.push(summary);
  }

  return summaries;
}
