import { test } from "node:test";
import assert from "node:assert/strict";
import { prettifyCompanySlug } from "./company-slug.js";

test("hyphen-separated slug becomes title-cased words", () => {
  assert.equal(prettifyCompanySlug("two-sigma"), "Two Sigma");
});

test("single-word slug is just capitalized", () => {
  assert.equal(prettifyCompanySlug("gitlab"), "Gitlab");
});

test("underscore and dot separators are treated the same as hyphens", () => {
  assert.equal(prettifyCompanySlug("acme_corp.io"), "Acme Corp Io");
});

test("idempotent: an already-prettified learned name is unchanged", () => {
  // Load-bearing: the orchestrator may pass back a previously-learned company name
  // (Decision 22's cache) instead of a raw slug — re-running this must not corrupt it.
  assert.equal(prettifyCompanySlug("Two Sigma"), "Two Sigma");
  assert.equal(prettifyCompanySlug("Palantir"), "Palantir");
});
