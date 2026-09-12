import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cosineSim,
  precisionAtK,
  projectRanking,
  stratifiedAllocate,
  poolTopK,
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
