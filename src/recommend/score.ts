import { W_SIM, W_FRESH, FRESHNESS_HALF_LIFE_DAYS } from "./config.js";

// Scoring (spec "Ranking"): pure math, no model calls — the determinism claim, precisely:
// scores drift with TIME by design (freshness decay), never with a model's mood.

const MS_PER_DAY = 86_400_000;

// Exponential decay with a ~30-day half-life on publishedAt, falling back to firstSeenAt
// (the honest "when did we learn about this" when the source states no publish date).
// Future dates clamp to age 0 rather than scoring >1 — a source's clock skew shouldn't
// mint bonus freshness.
export function freshness(publishedAt: Date | null, firstSeenAt: Date, now = new Date()): number {
  const anchor = publishedAt ?? firstSeenAt;
  const ageDays = Math.max(0, (now.getTime() - anchor.getTime()) / MS_PER_DAY);
  return Math.exp((-Math.LN2 * ageDays) / FRESHNESS_HALF_LIFE_DAYS);
}

export function blendScore(similarity: number, fresh: number): number {
  return W_SIM * similarity + W_FRESH * fresh;
}

// (score desc, id asc): the id tiebreak makes ordering — and therefore pagination slices —
// deterministic for a fixed dataset and scoring time. Pagination can still shift as
// freshness decays or listings change between requests; that's the documented behavior.
export function sortRecs<T extends { score: number; id: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.id - b.id);
}

// Qualitative bands only — cosine is NEVER rendered as a percentage (spec). Thresholds are
// PROVISIONAL until the eval gate's labeled set calibrates them (Task 14 of the plan);
// they gate copy ("strong match"), not filtering, so a miscalibration is cosmetic.
export const BAND_STRONG = 0.6;
export const BAND_GOOD = 0.45;

export function band(score: number): "strong" | "good" | "fair" {
  if (score >= BAND_STRONG) return "strong";
  if (score >= BAND_GOOD) return "good";
  return "fair";
}
