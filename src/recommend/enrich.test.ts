import { test } from "node:test";
import assert from "node:assert/strict";
import { needsSignature, embedBatches } from "./enrich.js";

// Pure decision pieces of the enrichment pass. The DB writes themselves (including the
// crash-window clear) are single SQL statements smoke-tested via `npm run enrich -- --limit`.

test("needsSignature: null stored fingerprint is stale; mismatch is stale; equal is fresh", () => {
  assert.equal(needsSignature({ signatureFingerprint: null }, "abc"), true);
  assert.equal(needsSignature({ signatureFingerprint: "old" }, "abc"), true);
  assert.equal(needsSignature({ signatureFingerprint: "abc" }, "abc"), false);
});

test("embedBatches: splits into stable batches, preserving order", () => {
  const items = Array.from({ length: 35 }, (_, i) => i);
  const b = embedBatches(items, 16);
  assert.deepEqual(
    b.map((x) => x.length),
    [16, 16, 3],
  );
  assert.deepEqual(b.flat(), items);
  assert.deepEqual(embedBatches([], 16), []);
});
