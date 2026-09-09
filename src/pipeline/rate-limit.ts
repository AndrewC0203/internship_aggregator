// Fixed per-host request pacing (Decision 27). The three ATS posting APIs are public,
// unauthenticated, Cloudflare-fronted, and publish NO rate limits — the failure mode of
// crawling them too fast isn't a 429, it's silent IP-reputation damage. So the posture is
// visible politeness: a constant minimum gap between requests to one host, chosen for
// simplicity over throughput because every crawl here is a background job (monthly
// discovery, daily refresh) where wall-clock is nearly free. See DECISIONS.md Decision 27
// for the alternatives (token bucket, adaptive) and why they lost.
//
// One gate per HOST, which in practice means one per source: each orchestrator loop is
// serial per source, and each source speaks to exactly one API host. The gate paces
// board-level calls; Lever's internal page requests within one board are NOT paced (a
// board is ≤ a handful of quick pages, then the gate re-spaces) — accepted in Decision 27.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Minimum gap between requests to one ATS host. 500ms = 2 req/s sustained — a full
// ~2,700-board discovery sweep takes ~23 min, far below any plausible abuse threshold.
export const ATS_MIN_INTERVAL_MS = Number(process.env.ATS_MIN_INTERVAL_MS ?? 500);

// How long to pause a host's loop after it answers 429. The fetch errors don't carry
// Retry-After (and none of these APIs has been observed sending one), so a flat pause
// stands in for it: long enough to matter, short enough not to strand a daily run.
export const ATS_429_PAUSE_MS = Number(process.env.ATS_429_PAUSE_MS ?? 60_000);

export interface RateGate {
  // Resolves when it's this caller's turn; reserves the next slot on entry, so even
  // concurrent callers space out correctly (the current loops are serial anyway).
  wait(): Promise<void>;
}

export function createRateGate(
  minIntervalMs: number,
  opts: { sleepFn?: (ms: number) => Promise<void>; nowFn?: () => number } = {},
): RateGate {
  const sleepFn = opts.sleepFn ?? sleep;
  const nowFn = opts.nowFn ?? Date.now;

  let nextSlotAt = 0;
  return {
    async wait(): Promise<void> {
      const now = nowFn();
      const delay = nextSlotAt - now;
      nextSlotAt = Math.max(now, nextSlotAt) + minIntervalMs;
      if (delay > 0) await sleepFn(delay);
    },
  };
}

// Shared 429 pause: log which host tripped it, then hold that source's loop. Kept here so
// both orchestrators pause identically.
export async function pauseAfter429(
  source: string,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  console.error(
    `  [${source}] got 429 — pausing this source for ${ATS_429_PAUSE_MS / 1000}s before continuing`,
  );
  await sleepFn(ATS_429_PAUSE_MS);
}
