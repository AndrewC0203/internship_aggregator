import type { Source } from "@prisma/client";
import type { FetchResult } from "../pipeline/types.js";

// Discovery is slug-only (Decision 11): a discovered target is just its source + board token.
export interface DiscoveredToken {
  source: Source;
  token: string;
}

// Options threaded from the CLI runner down into each source's discovery.
export interface DiscoveryOptions {
  // Specific Common Crawl crawl id (e.g. "CC-MAIN-2026-25"); undefined = use the latest.
  crawlId?: string;
  // Stop collecting candidates once we have at least this many unique tokens. Lets a capped
  // run (`--limit`) avoid paging the entire CDX index. undefined = collect everything.
  targetCount?: number;
}

// A board fetcher used by the validation step: returns the board's fetch result (throws on
// HTTP/parse failure). The existing per-source fetch functions already match this shape —
// discovery never passes a prior etag, so it always gets the full "ok" response
// (see FetchResult in ../pipeline/types.ts, Decision 23).
export type BoardFetcher = (token: string, priorEtag?: string | null) => Promise<FetchResult>;

// Each ATS implements this. `discoverCandidates` mines Common Crawl for candidate tokens;
// `fetchBoard` is that source's live fetcher, reused by validation to confirm a board is
// real. Keeping both on one object means the orchestrator stays source-agnostic.
export interface DiscoverySource {
  source: Source;
  discoverCandidates(opts: DiscoveryOptions): Promise<string[]>;
  fetchBoard: BoardFetcher;
}
