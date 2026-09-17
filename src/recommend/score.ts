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

// Qualitative bands only — cosine is NEVER rendered as a percentage (spec). RANK-based,
// not score-threshold-based, by measurement (eval gate 2026-09-14): the labeled classes'
// similarity distributions overlap almost completely (relevant median 0.707, irrelevant
// median 0.688, irrelevant MAX 0.749) — an absolute threshold cannot honestly separate
// them, while the ordering demonstrably can (P@10 lenient 0.80-0.90). So a band claims
// "among today's best matches for you", which is relative by construction: top ~10% of
// the eligible set (min 5) = strong, next ~25% = good, rest = fair.
export function band(rank: number, total: number): "strong" | "good" | "fair" {
  const strongCutoff = Math.max(5, Math.ceil(total * 0.1));
  if (rank < strongCutoff) return "strong";
  // Cumulative, not absolute: "good" is the next ~25% AFTER wherever strong actually ends.
  // An absolute ceil(total*0.35) line sat below the min-5 strong floor for every total <= 14,
  // making "good" unreachable exactly where bands matter most (small filtered sets).
  if (rank < strongCutoff + Math.ceil(total * 0.25)) return "good";
  return "fair";
}
