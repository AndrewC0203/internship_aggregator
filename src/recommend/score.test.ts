import { test } from "node:test";
import assert from "node:assert/strict";
import { freshness, blendScore, sortRecs, band } from "./score.js";

const D = (s: string) => new Date(s);
const NOW = D("2026-09-12T00:00:00Z");

test("freshness: 1.0 at age 0, 0.5 at one half-life (30d), monotone decay", () => {
  assert.ok(Math.abs(freshness(NOW, NOW, NOW) - 1) < 1e-9);
  assert.ok(Math.abs(freshness(D("2026-08-13T00:00:00Z"), NOW, NOW) - 0.5) < 0.01);
  assert.ok(
    freshness(D("2026-06-01T00:00:00Z"), NOW, NOW) < freshness(D("2026-09-01T00:00:00Z"), NOW, NOW),
  );
});

test("freshness: publishedAt null falls back to firstSeenAt; future dates clamp to age 0", () => {
  assert.equal(freshness(null, NOW, NOW), freshness(NOW, NOW, NOW));
  assert.equal(freshness(D("2026-09-13T00:00:00Z"), NOW, NOW), 1);
});

test("blend: W_SIM/W_FRESH named-constant math (0.95/0.05, validated at the eval gate)", () => {
  assert.ok(Math.abs(blendScore(1, 0) - 0.95) < 1e-9);
  assert.ok(Math.abs(blendScore(0, 1) - 0.05) < 1e-9);
  assert.ok(Math.abs(blendScore(1, 1) - 1) < 1e-9);
});

test("sort: score desc, id asc tiebreak — deterministic pagination for a fixed dataset", () => {
  const rows = [
    { id: 2, score: 0.5 },
    { id: 1, score: 0.5 },
    { id: 3, score: 0.9 },
  ];
  assert.deepEqual(
    sortRecs(rows).map((r) => r.id),
    [3, 1, 2],
  );
});

test("bands are rank-based (absolute similarity can't separate labeled classes — measured)", () => {
  // 200 eligible: top 20 strong (10%), through rank 69 good (35%), rest fair.
  assert.equal(band(0, 200), "strong");
  assert.equal(band(19, 200), "strong");
  assert.equal(band(20, 200), "good");
  assert.equal(band(69, 200), "good");
  assert.equal(band(70, 200), "fair");
  // Tiny corpus: the strong band never shrinks below 5.
  assert.equal(band(4, 8), "strong");
});

test("small sets still have a good band — next ~25% after strong, not an absolute 35% line", () => {
  // 10 eligible: ranks 0-4 strong (min-5 floor), 5-7 good (next ~25%), 8-9 fair.
  // Regression pin: with an absolute ceil(total*0.35) cutoff, the min-5 strong floor
  // swallowed the whole good band for every total <= 14 — "good" was unreachable.
  assert.equal(band(5, 10), "good");
  assert.equal(band(7, 10), "good");
  assert.equal(band(8, 10), "fair");
  assert.equal(band(5, 14), "good");
});
