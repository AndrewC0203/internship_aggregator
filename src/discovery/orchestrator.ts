import { prisma } from "../db.js";
import type { DiscoveryOptions, DiscoverySource } from "./types.js";
import { greenhouseDiscovery } from "./greenhouse.js";
import { leverDiscovery } from "./lever.js";
import { ashbyDiscovery } from "./ashby.js";
import { validateToken } from "./validate.js";
import { ATS_MIN_INTERVAL_MS, createRateGate, pauseAfter429 } from "../pipeline/rate-limit.js";

export interface DiscoverySummary {
  source: string;
  discovered: number; // unique candidate tokens from Common Crawl (before any cap)
  processed: number; // how many we actually validated (after --limit cap)
  kept: number; // validated live -> upserted as targets
  dropped: number; // 404 / empty board -> not a target
  errors: number; // transient failures skipped this run
}

const SOURCES: DiscoverySource[] = [greenhouseDiscovery, leverDiscovery, ashbyDiscovery];

export interface RunOptions extends DiscoveryOptions {
  // Cap the validation sweep — smoke-test knob. Full sweeps are unblocked now that pacing
  // exists (Decision 27); a ~2,700-token sweep at the default 500ms gap takes ~23 min.
  limit?: number;
  // Run only this source (e.g. "lever") instead of all of them. Discovery runs are
  // independent per source, and mining one ATS shouldn't force re-paging the other's index.
  source?: string;
}

export async function runDiscovery(opts: RunOptions = {}): Promise<DiscoverySummary[]> {
  const summaries: DiscoverySummary[] = [];

  const sources = opts.source ? SOURCES.filter((s) => s.source === opts.source) : SOURCES;
  if (opts.source && sources.length === 0) {
    throw new Error(
      `Unknown discovery source "${opts.source}" (implemented: ${SOURCES.map((s) => s.source).join(", ")})`,
    );
  }

  for (const src of sources) {
    // targetCount lets discovery stop paging Common Crawl early on a capped run.
    const discovered = await src.discoverCandidates({
      crawlId: opts.crawlId,
      targetCount: opts.limit,
    });

    const processed = opts.limit ? discovered.slice(0, opts.limit) : discovered;
    if (opts.limit && discovered.length > opts.limit) {
      console.error(
        `  [${src.source}] capping validation at ${opts.limit}/${discovered.length} candidates (--limit)`,
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

    // One gate per source = one per API host (each source speaks to exactly one host).
    // Fresh per run/source on purpose: pacing is about request spacing, not global state.
    const gate = createRateGate(ATS_MIN_INTERVAL_MS);

    for (const token of processed) {
      await gate.wait();
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
      } else if (outcome === "rate_limited") {
        // The host pushed back: this token is skipped this run (counted as an error, same
        // as any transient failure), and the whole source's loop pauses before continuing
        // (Decision 27) — the point is to yield, not to power through.
        summary.errors++;
        await pauseAfter429(src.source);
      } else {
        summary.errors++;
        console.error(`  [${src.source}] transient error validating "${token}" — skipped this run`);
      }
    }

    summaries.push(summary);
  }

  return summaries;
}
