import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLever } from "./normalize.js";

// Fixture captured live from Palantir's Lever board (2026-08-31), not synthesized — picked to
// cover three distinct `categories.commitment` values none of which is the plain "Internship"
// any Lever doc mentions: "Full-time", "Scholarship" (a fellowship-shaped role Lever gives no
// dedicated commitment value for), and "Fixed-Term".
const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/palantir.postings.sample.json", import.meta.url), "utf8"),
) as Array<Record<string, unknown>>;

const [fullTime, scholarship, fixedTerm] = fixture;

test("company comes from ctx, not the payload — Lever postings never state one", () => {
  const out = normalizeLever(fullTime, { company: "palantir" });
  assert.equal(out?.company, "Palantir");
});

test("an already-prettified learned company name passes through unchanged", () => {
  const out = normalizeLever(fullTime, { company: "Palantir" });
  assert.equal(out?.company, "Palantir");
});

test("missing ctx.company drops the job rather than guessing", () => {
  assert.equal(normalizeLever(fullTime, {}), null);
  assert.equal(normalizeLever(fullTime, { company: "  " }), null);
});

test("createdAt (epoch milliseconds) converts to the correct Date, not a garbage far-future one", () => {
  const out = normalizeLever(fullTime, { company: "palantir" })!;
  assert.equal(out.publishedAt?.toISOString(), "2024-03-25T21:50:16.463Z");
});

test("known commitment values map to the matching EmploymentType", () => {
  assert.equal(normalizeLever(fullTime, { company: "palantir" })?.employmentType, "full_time");
  assert.equal(normalizeLever(fixedTerm, { company: "palantir" })?.employmentType, "temporary");
});

test("an unmapped commitment value ('Scholarship') falls through to null, not a thrown error", () => {
  // This is the friction point: Palantir uses "Scholarship" for what reads like a fellowship
  // ("American Tech Fellowship"), a value no Lever doc or Prisma enum anticipates. Dropping to
  // null must not drop the LISTING — opportunityType is still classified from title/description
  // downstream regardless of this field.
  const out = normalizeLever(scholarship, { company: "palantir" });
  assert.ok(out, "the listing itself must survive an unmapped commitment value");
  assert.equal(out.employmentType, null);
  assert.equal(out.title, "American Tech Fellowship");
});

test("workplaceType values map straight across (Prisma's enum already matches Lever's casing)", () => {
  assert.equal(normalizeLever(fullTime, { company: "palantir" })?.workplaceType, "hybrid");
  assert.equal(normalizeLever(scholarship, { company: "palantir" })?.workplaceType, "remote");
});

test("descriptionPlain is used as-is — no leftover HTML tags or entities", () => {
  const out = normalizeLever(fullTime, { company: "palantir" })!;
  assert.doesNotMatch(out.descriptionPlain, /<[a-z][^>]*>/i);
  assert.doesNotMatch(out.descriptionPlain, /&lt;|&gt;|&amp;/);
});

test("descriptionHtml keeps real markup", () => {
  const out = normalizeLever(fullTime, { company: "palantir" })!;
  assert.match(out.descriptionHtml, /<[a-z][^>]*>/i);
});

test("url is hostedUrl (the posting page), not applyUrl (the form)", () => {
  const out = normalizeLever(fullTime, { company: "palantir" })!;
  assert.equal(out.url, fullTime.hostedUrl);
});

test("applicationDeadline is always null — not present on Lever's public postings object", () => {
  const out = normalizeLever(fullTime, { company: "palantir" })!;
  assert.equal(out.applicationDeadline, null);
});

test("duplicateKeys starts empty — only dedup.ts ever populates it", () => {
  const out = normalizeLever(fullTime, { company: "palantir" })!;
  assert.deepEqual(out.duplicateKeys, []);
});

test("location and department read from categories, falling back to null", () => {
  const out = normalizeLever(fullTime, { company: "palantir" })!;
  assert.equal(out.location, "London, United Kingdom");
  assert.equal(out.department, null); // this fixture job has no categories.department at all
});
