import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDegreeStatus, passModel } from "./classifier.js";

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

// ── passModel: per-pass model resolution (Decision 25 split) ───────────────────────────────
// Precedence: per-pass env var > global OLLAMA_MODEL > per-pass default. The global override
// must keep working — bench scripts and `OLLAMA_MODEL=x npm run reclassify` rely on forcing
// ONE model everywhere; the split only changes what happens when nothing is set.

test("defaults: classify gets the 14B, extract gets the 7B", () => {
  assert.equal(passModel("classify", {}), "qwen2.5:14b-instruct");
  assert.equal(passModel("extract", {}), "qwen2.5:7b-instruct");
});

test("global OLLAMA_MODEL overrides both passes — the bench/reclassify escape hatch", () => {
  const env = { OLLAMA_MODEL: "qwen2.5:32b-instruct" };
  assert.equal(passModel("classify", env), "qwen2.5:32b-instruct");
  assert.equal(passModel("extract", env), "qwen2.5:32b-instruct");
});

test("per-pass env beats the global", () => {
  const env = { OLLAMA_MODEL: "global-model", OLLAMA_EXTRACT_MODEL: "extract-model" };
  assert.equal(passModel("extract", env), "extract-model");
  assert.equal(passModel("classify", env), "global-model");
  assert.equal(
    passModel("classify", { ...env, OLLAMA_CLASSIFY_MODEL: "classify-model" }),
    "classify-model",
  );
});
