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

test("blend: W_SIM/W_FRESH named-constant math (0.85/0.15)", () => {
  assert.ok(Math.abs(blendScore(1, 0) - 0.85) < 1e-9);
  assert.ok(Math.abs(blendScore(0, 1) - 0.15) < 1e-9);
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

test("bands are qualitative only (provisional thresholds, calibrated at the eval gate)", () => {
  assert.equal(band(0.7), "strong");
  assert.equal(band(0.5), "good");
  assert.equal(band(0.2), "fair");
});
