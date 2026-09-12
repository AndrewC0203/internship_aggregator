// Pure metric functions for the evaluation gate (Decision 31 amendment; spec "Evaluation
// gate"). Everything here is deterministic and model-free so the metrics themselves are
// testable — the eval CLI (src/eval-recommend.ts) is I/O glue around these.

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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
