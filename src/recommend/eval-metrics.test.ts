import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cosineSim,
  precisionAtK,
  projectRanking,
  stratifiedAllocate,
  poolTopK,
  ndcgAtK,
  blendRanked,
  labelFromCsvLine,
} from "./eval-metrics.js";

test("cosineSim: orthogonal 0, identical 1, scale-invariant", () => {
  assert.ok(Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineSim([1, 2], [1, 2]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSim([1, 2], [2, 4]) - 1) < 1e-9);
});

test("precisionAtK: borderline strict vs lenient (pre-registered primary = strict)", () => {
  const labels = new Map<number, string>([
    [1, "relevant"],
    [2, "borderline"],
    [3, "irrelevant"],
    [4, "relevant"],
  ]);
  const ranked = [1, 2, 3, 4];
  assert.equal(precisionAtK(ranked, labels, 4, "strict"), 2 / 4);
  assert.equal(precisionAtK(ranked, labels, 4, "lenient"), 3 / 4);
  assert.equal(precisionAtK(ranked, labels, 2, "strict"), 1 / 2);
});

test("precisionAtK: throws on an unlabeled item in the window — pooling guarantees coverage", () => {
  const labels = new Map<number, string>([[1, "relevant"]]);
  assert.throws(() => precisionAtK([1, 99], labels, 2, "strict"), /unlabeled/);
});

test("projectRanking: filters to allowed ids, preserving order (holdout projection)", () => {
  assert.deepEqual(projectRanking([5, 3, 8, 1], new Set([3, 1])), [3, 1]);
});

test("stratifiedAllocate: proportional, min 1 per non-empty cell, respects cell size + target", () => {
  const cells = new Map<string, number>([
    ["swe|internship", 100],
    ["ml_ai|internship", 50],
    ["data|new_grad", 2],
    ["null|null", 48],
  ]);
  const alloc = stratifiedAllocate(cells, 20);
  const total = [...alloc.values()].reduce((a, b) => a + b, 0);
  assert.ok(total <= 20, `total ${total}`);
  for (const [key, n] of alloc) {
    assert.ok(n >= 1, `${key} got 0`);
    assert.ok(n <= cells.get(key)!, `${key} over cell size`);
  }
  // Rough proportionality: the biggest cell gets the biggest allocation.
  assert.ok(alloc.get("swe|internship")! >= alloc.get("ml_ai|internship")!);
  // Deterministic across calls.
  assert.deepEqual([...alloc.entries()], [...stratifiedAllocate(cells, 20).entries()]);
});

test("poolTopK: union of every approach's top-K, first-seen order, deduped", () => {
  const pool = poolTopK({ a: [1, 2, 3], b: [3, 4], c: [2, 5] }, 2);
  assert.deepEqual(pool, [1, 2, 3, 4, 5]);
});

test("cosineSim: length mismatch and zero vectors are hard errors, never NaN", () => {
  // Same posture as precisionAtK's unlabeled-item throw: an eval harness must fail loud —
  // a NaN here would flow into sort() and silently garble the bake-off ranking.
  assert.throws(() => cosineSim([1, 0], [1]), /length mismatch/);
  assert.throws(() => cosineSim([0, 0], [1, 1]), /zero vector/);
});

// ── ndcgAtK ────────────────────────────────────────────────────────────────────────────────
// Position-aware companion to P@K: linear gains relevant=2 / borderline=1 / irrelevant=0,
// discounted by log2(position+2), normalized by the ideal ordering of the SAME id list.
// P@10 structurally can't see whether the blend pushes good matches toward rank 1 or just
// parks them anywhere in the window — NDCG can.

test("ndcgAtK: perfect ordering scores 1, worst ordering scores below it", () => {
  const labels = new Map<number, string>([
    [1, "relevant"],
    [2, "borderline"],
    [3, "irrelevant"],
  ]);
  assert.equal(ndcgAtK([1, 2, 3], labels, 3), 1);
  assert.ok(ndcgAtK([3, 2, 1], labels, 3) < 1);
});

test("ndcgAtK: rewards a relevant item at rank 1 over the same item at rank 3", () => {
  const labels = new Map<number, string>([
    [1, "relevant"],
    [2, "irrelevant"],
    [3, "irrelevant"],
  ]);
  assert.ok(ndcgAtK([1, 2, 3], labels, 3) > ndcgAtK([2, 3, 1], labels, 3));
});

test("ndcgAtK: all-irrelevant list scores 0; unlabeled id is a hard error", () => {
  const labels = new Map<number, string>([
    [1, "irrelevant"],
    [2, "irrelevant"],
  ]);
  assert.equal(ndcgAtK([1, 2], labels, 2), 0);
  assert.throws(() => ndcgAtK([1, 99], labels, 2), /unlabeled/);
});

// ── blendRanked ────────────────────────────────────────────────────────────────────────────
// Pool-time ranking must match production's blend (bakeoff.md's own flagged gap: "pooling
// was built on similarity-only rankings, but production ranks by blend"). Pinned `now` so
// a re-run reproduces the exact ranking.

test("blendRanked: freshness breaks a similarity tie toward the newer listing", () => {
  const now = new Date("2026-09-17T00:00:00Z");
  const rows = [
    { id: 1, sim: 0.7, publishedAt: "2026-06-01T00:00:00Z", firstSeenAt: "2026-06-01T00:00:00Z" },
    { id: 2, sim: 0.7, publishedAt: "2026-09-16T00:00:00Z", firstSeenAt: "2026-09-16T00:00:00Z" },
  ];
  assert.deepEqual(blendRanked(rows, now).map((r) => r.id), [2, 1]);
});

test("blendRanked: W_FRESH stays a nudge — a real similarity gap beats maximal freshness", () => {
  const now = new Date("2026-09-17T00:00:00Z");
  const rows = [
    { id: 1, sim: 0.75, publishedAt: "2025-01-01T00:00:00Z", firstSeenAt: "2025-01-01T00:00:00Z" },
    { id: 2, sim: 0.65, publishedAt: "2026-09-17T00:00:00Z", firstSeenAt: "2026-09-17T00:00:00Z" },
  ];
  const out = blendRanked(rows, now);
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
  // Carries both scores: sim for diagnostics, score (the blend) as the ranking key.
  assert.ok(out[0].score > out[0].sim * 0.95 - 1e-9);
});

// ── labelFromCsvLine ───────────────────────────────────────────────────────────────────────
// One parse shared by readLabels (strict: throw on missing) and pool's carry-forward merge
// (lenient: unlabeled row -> null, never a URL misread as a label).

test("labelFromCsvLine: labeled row parses id + label through quoted commas", () => {
  assert.deepEqual(labelFromCsvLine('12,"Acme, Inc","SWE Intern","https://x.co/a",relevant'), {
    id: 12,
    label: "relevant",
  });
  assert.deepEqual(labelFromCsvLine('7,"A","T","https://x.co/b", Borderline '), {
    id: 7,
    label: "borderline",
  });
});

test("labelFromCsvLine: unlabeled row yields null label — the URL must not read as a label", () => {
  assert.deepEqual(labelFromCsvLine('9,"A","T","https://x.co/c",'), { id: 9, label: null });
});
