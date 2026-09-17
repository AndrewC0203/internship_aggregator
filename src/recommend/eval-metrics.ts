// Pure metric functions for the evaluation gate (Decision 31 amendment; spec "Evaluation
// gate"). Everything here is deterministic and model-free so the metrics themselves are
// testable — the eval CLI (src/eval-recommend.ts) is I/O glue around these.

import { freshness, blendScore, sortRecs } from "./score.js";

export function cosineSim(a: number[], b: number[]): number {
  // Hard errors, same posture as precisionAtK's unlabeled-item throw: a NaN from a length
  // mismatch or zero vector would flow into sort() and silently garble a bake-off ranking.
  if (a.length !== b.length) {
    throw new Error(`cosineSim: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) throw new Error("cosineSim: zero vector");
  return dot / denom;
}

// Precision@K. Pre-registered primary metric = "strict": borderline counts as NOT relevant
// (a recommender that fills the top with borderlines should not look good). "lenient" is
// the reported-secondary. An unlabeled item inside the window is a HARD error: pooled
// labeling exists precisely so no approach's top-K contains unjudged items.
export function precisionAtK(
  rankedIds: number[],
  labels: Map<number, string>,
  k: number,
  mode: "strict" | "lenient",
): number {
  const window = rankedIds.slice(0, k);
  let hits = 0;
  for (const id of window) {
    const label = labels.get(id);
    if (!label) throw new Error(`precisionAtK: unlabeled item ${id} in top-${k}`);
    if (label === "relevant" || (mode === "lenient" && label === "borderline")) hits++;
  }
  return hits / window.length;
}

// NDCG@K — position-aware companion to precisionAtK. Linear gains (relevant=2,
// borderline=1, irrelevant=0: interpretable, and the strict/lenient P@K pair already
// covers emphasis questions), log2 positional discount, normalized against the ideal
// ordering of the SAME id list — so it isolates ORDERING quality from retrieval quality.
// Meant for projected (fully labeled) rankings; an unlabeled id anywhere is a hard error,
// same posture as precisionAtK. All-zero gains (nothing relevant in the list) return 0.
const NDCG_GAIN: Record<string, number> = { relevant: 2, borderline: 1, irrelevant: 0 };

export function ndcgAtK(rankedIds: number[], labels: Map<number, string>, k: number): number {
  const gains = rankedIds.map((id) => {
    const label = labels.get(id);
    if (label === undefined) throw new Error(`ndcgAtK: unlabeled item ${id}`);
    return NDCG_GAIN[label] ?? 0;
  });
  const dcgAt = (gs: number[]): number =>
    gs.slice(0, k).reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
  const ideal = dcgAt([...gains].sort((a, b) => b - a));
  return ideal === 0 ? 0 : dcgAt(gains) / ideal;
}

// Blend-consistent ranking for the pool step: production ranks by blendScore(sim, fresh),
// so pooled labeling must draw top-Ks from the same ordering (bakeoff.md flagged pooling
// on similarity-only as a known gap). `now` is pinned by the caller and persisted next to
// the rankings so a re-run reproduces the exact ordering. Carries sim alongside the blend
// so diagnostics can still compare similarity-only vs blended orderings.
export function blendRanked(
  rows: Array<{ id: number; sim: number; publishedAt: string | null; firstSeenAt: string }>,
  now: Date,
): Array<{ id: number; sim: number; score: number }> {
  return sortRecs(
    rows.map((r) => ({
      id: r.id,
      sim: r.sim,
      score: blendScore(
        r.sim,
        freshness(r.publishedAt ? new Date(r.publishedAt) : null, new Date(r.firstSeenAt), now),
      ),
    })),
  );
}

// One tolerant labels.csv line parse, shared by the strict reader (missing label -> throw)
// and pool's carry-forward merge (missing label -> null). The label is the LAST NON-EMPTY
// field IF it is a known label value — otherwise null, so an unlabeled row's trailing URL
// can never be misread as a label.
const LABEL_VALUES = new Set(["relevant", "borderline", "irrelevant"]);

export function labelFromCsvLine(line: string): { id: number; label: string | null } {
  const fields = line.split(",").map((f) => f.replaceAll('"', "").trim());
  const candidate = (fields.filter(Boolean).at(-1) ?? "").toLowerCase();
  return { id: Number(fields[0]), label: LABEL_VALUES.has(candidate) ? candidate : null };
}

// Project a ranking onto an allowed id set, preserving order. This is how the held-out
// check works with item-level labels and a single profile-query: selection metrics run on
// the ranking projected to the SELECT slice; the final check runs on the HOLDOUT slice,
// which never influenced the choice.
export function projectRanking(rankedIds: number[], allowed: Set<number>): number[] {
  return rankedIds.filter((id) => allowed.has(id));
}

// Largest-remainder (Hamilton) allocation over strata with a min-1 floor per non-empty
// cell, clamped to cell size, total <= target. Deterministic: cells iterate in sorted-key
// order and every tiebreak is by key. Used to draw the ~200-listing stratified sample over
// (csField x opportunityType).
export function stratifiedAllocate(
  cells: Map<string, number>,
  target: number,
): Map<string, number> {
  const keys = [...cells.keys()].sort();
  const total = keys.reduce((sum, k) => sum + cells.get(k)!, 0);
  if (total === 0) return new Map();

  // Floor of the exact quota, min 1, clamped to the cell.
  const alloc = new Map<string, number>();
  const remainders: Array<{ key: string; rem: number }> = [];
  for (const key of keys) {
    const n = cells.get(key)!;
    const quota = (target * n) / total;
    alloc.set(key, Math.min(n, Math.max(1, Math.floor(quota))));
    remainders.push({ key, rem: quota - Math.floor(quota) });
  }

  // Distribute leftover seats by largest remainder (tie: key asc), never past cell size.
  let allocated = [...alloc.values()].reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.rem - a.rem || (a.key < b.key ? -1 : 1));
  for (const { key } of remainders) {
    if (allocated >= target) break;
    if (alloc.get(key)! < cells.get(key)!) {
      alloc.set(key, alloc.get(key)! + 1);
      allocated++;
    }
  }

  // The min-1 floor can overshoot the target when there are many tiny cells: shave from
  // the largest allocations (tie: key desc) until we fit, never below 1.
  while (allocated > target) {
    let bestKey: string | null = null;
    for (const key of keys) {
      const n = alloc.get(key)!;
      if (n <= 1) continue;
      if (
        bestKey === null ||
        n > alloc.get(bestKey)! ||
        (n === alloc.get(bestKey)! && key > bestKey)
      ) {
        bestKey = key;
      }
    }
    if (!bestKey) break; // every cell at the floor — nothing left to shave
    alloc.set(bestKey, alloc.get(bestKey)! - 1);
    allocated--;
  }

  return alloc;
}

// Union of every approach's top-K, first-seen order across approaches (stable input order),
// deduped — the labeling sheet's row source.
export function poolTopK(rankings: Record<string, number[]>, k: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const ids of Object.values(rankings)) {
    for (const id of ids.slice(0, k)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
