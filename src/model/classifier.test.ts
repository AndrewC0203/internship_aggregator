import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDegreeStatus } from "./classifier.js";

// Boundary guard for the extract pass's degree_status field (Decision 24). Same seam as
// gradField/parseDate in classifier.ts: the JSON schema guarantees SHAPE, not semantics, and
// Ollama's structured-output enforcement is an external guarantee we don't own — so anything
// that isn't exactly one of our enum values must normalize to null, never leak into a row.

test("valid degree statuses pass through unchanged", () => {
  assert.equal(normalizeDegreeStatus("pursuing"), "pursuing");
  assert.equal(normalizeDegreeStatus("completed_required"), "completed_required");
  assert.equal(normalizeDegreeStatus("unknown"), "unknown");
});

test("null passes through as null — posting said nothing about degrees", () => {
  assert.equal(normalizeDegreeStatus(null), null);
});

test("junk strings normalize to null, never leak into the data model", () => {
  // Plausible 7B failure modes: paraphrase, casing drift, prose instead of the enum token.
  assert.equal(normalizeDegreeStatus("bachelors_required"), null);
  assert.equal(normalizeDegreeStatus("Pursuing"), null);
  assert.equal(normalizeDegreeStatus("the posting requires a completed degree"), null);
  assert.equal(normalizeDegreeStatus(""), null);
});
