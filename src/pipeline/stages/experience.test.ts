import { test } from "node:test";
import assert from "node:assert/strict";
import { minYearsExperience } from "./experience.js";

// minYearsExperience() is a fact extractor: it reports the smallest stated minimum, and the
// keep/drop threshold lives in filter.ts. So these tests assert NUMBERS, not verdicts — if the
// cutoff changes in v1, none of them should need editing.

// --- the three real postings that motivated this (research/yoe-filter-analysis.md) ---

test("'0-3 years' has a minimum of 0 — the posting we correctly kept", () => {
  // Junior Engineer @ 2K: "Experience: 0–3 years of experience (excellent fresh graduates
  // are welcome to apply)". A regex matching any number would return 3 and drop it.
  assert.equal(minYearsExperience("Experience: 0–3 years of experience (fresh grads welcome)"), 0);
});

test("'2+ years' has a minimum of 2 — the two false keeps", () => {
  assert.equal(minYearsExperience("2+ years of UX or other social science research"), 2);
  assert.equal(minYearsExperience("Experience: 2+ years in data or product analytics."), 2);
});

// --- range and suffix forms ---

test("reads the FIRST number of a range, not the last", () => {
  assert.equal(minYearsExperience("3-5 years of experience"), 3);
  assert.equal(minYearsExperience("5 to 7 years of experience"), 5);
  assert.equal(minYearsExperience("0 to 1 year of experience"), 0);
});

test("handles en dash and em dash ranges", () => {
  assert.equal(minYearsExperience("4–6 years"), 4);
  assert.equal(minYearsExperience("4—6 years"), 4);
});

test("handles singular 'year'", () => {
  assert.equal(minYearsExperience("1 year of experience"), 1);
});

test("handles a plain number with no plus or range", () => {
  assert.equal(minYearsExperience("We require 8 years in the field"), 8);
});

// --- the min-across-matches rule ---

test("takes the SMALLEST minimum across several mentions — keep-biased", () => {
  // A self-contradictory posting should resolve to the reading most favourable to keeping it,
  // because a false reject is invisible while a false keep is visible and reversible.
  assert.equal(
    minYearsExperience("0-3 years required. 5+ years strongly preferred."),
    0,
  );
  assert.equal(minYearsExperience("6+ years backend. 2+ years distributed systems."), 2);
});

// --- absence ---

test("returns null when the posting states no experience minimum", () => {
  assert.equal(minYearsExperience("We are hiring a software engineering intern."), null);
  assert.equal(minYearsExperience(""), null);
});

test("null is distinct from 0 — 'states nothing' is not 'states zero'", () => {
  // filter.ts relies on this: null must not be treated as a number and compared to the cutoff.
  assert.equal(minYearsExperience("No requirements listed"), null);
  assert.equal(minYearsExperience("0 years of experience required"), 0);
});

// --- things that must NOT be read as a year count ---

test("does not read a salary figure as years", () => {
  assert.equal(minYearsExperience("Compensation: $120,000 per year"), null);
});

test("does not read a graduation year as an experience minimum", () => {
  assert.equal(minYearsExperience("Graduating in 2027 or later"), null);
});

// --- documented limitations (pinned so a future widening is a deliberate change) ---

test("does NOT match word-form numbers (known limitation)", () => {
  assert.equal(minYearsExperience("one year of experience"), null);
});

test("does NOT match month-form durations (known limitation)", () => {
  assert.equal(minYearsExperience("18+ months of experience"), null);
});

test("is case-insensitive", () => {
  assert.equal(minYearsExperience("2+ YEARS OF EXPERIENCE"), 2);
});
