import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeAshby } from "./normalize.js";

// Fixture captured live 2026-09-08 (descriptions truncated for size; structure untouched).
// Mixed provenance on purpose — no single board covered every case:
//   [0] Notion "Software Engineer Intern (Winter 2027)" — employmentType Intern, and
//       `compensation` PRESENT but hollow (empty tiers/components, null summaries): the
//       board didn't opt into public comp, so includeCompensation=true returns a husk.
//   [1] Notion contractor role — employmentType Temporary.
//   [2] Ramp "Security Engineer, Cloud" — yearly salary + equity components.
//   [3] OpenAI "IT Support Specialist" — HOURLY salary (floats) + an equity component
//       whose interval is also "1 YEAR", pinning that comp selection is by
//       compensationType === "Salary", never by interval.
const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/ashby.jobs.sample.json", import.meta.url), "utf8"),
) as Array<Record<string, unknown>>;

const [intern, temporary, salaried, hourly] = fixture;

test("company comes from ctx, not the payload — Ashby postings never state one", () => {
  const out = normalizeAshby(intern, { company: "notion" });
  assert.equal(out?.company, "Notion");
});

test("an already-prettified learned company name passes through unchanged", () => {
  const out = normalizeAshby(intern, { company: "Notion" });
  assert.equal(out?.company, "Notion");
});

test("missing ctx.company drops the job rather than guessing", () => {
  assert.equal(normalizeAshby(intern, {}), null);
  assert.equal(normalizeAshby(intern, { company: "  " }), null);
});

test("id and title map straight across", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.equal(out.sourceExternalId, intern.id);
  assert.equal(out.title, "Software Engineer Intern (Winter 2027)");
  assert.equal(out.source, "ashby");
});

test("employmentType enum maps: Intern, Temporary, FullTime", () => {
  assert.equal(normalizeAshby(intern, { company: "notion" })?.employmentType, "intern");
  assert.equal(normalizeAshby(temporary, { company: "notion" })?.employmentType, "temporary");
  assert.equal(normalizeAshby(salaried, { company: "ramp" })?.employmentType, "full_time");
});

test("an unknown employmentType value falls through to null, not a thrown error", () => {
  const out = normalizeAshby({ ...intern, employmentType: "Apprentice" }, { company: "notion" });
  assert.ok(out, "the listing itself must survive an unmapped employmentType");
  assert.equal(out.employmentType, null);
});

test("workplaceType enum maps across all three values", () => {
  assert.equal(normalizeAshby(intern, { company: "notion" })?.workplaceType, "hybrid");
  assert.equal(
    normalizeAshby({ ...intern, workplaceType: "Remote" }, { company: "notion" })?.workplaceType,
    "remote",
  );
  assert.equal(
    normalizeAshby({ ...intern, workplaceType: "OnSite" }, { company: "notion" })?.workplaceType,
    "onsite",
  );
});

test("a missing workplaceType falls back to isRemote", () => {
  const noWpt = { ...intern } as Record<string, unknown>;
  delete noWpt.workplaceType;
  assert.equal(
    normalizeAshby({ ...noWpt, isRemote: true }, { company: "notion" })?.workplaceType,
    "remote",
  );
  assert.equal(
    normalizeAshby({ ...noWpt, isRemote: false }, { company: "notion" })?.workplaceType,
    null,
  );
});

test("yearly salary comp maps from the Salary summary component", () => {
  const out = normalizeAshby(salaried, { company: "ramp" })!;
  assert.equal(out.compMin, 211400);
  assert.equal(out.compMax, 290600);
  assert.equal(out.compCurrency, "USD");
  assert.equal(out.compInterval, "yearly");
});

test("hourly salary comp maps with float values, ignoring the equity component", () => {
  // The equity component here also says interval "1 YEAR" — if selection keyed on interval
  // instead of compensationType, comp would come out null or wrong.
  const out = normalizeAshby(hourly, { company: "openai" })!;
  assert.equal(out.compMin, 60.58);
  assert.equal(out.compMax, 108.17);
  assert.equal(out.compCurrency, "USD");
  assert.equal(out.compInterval, "hourly");
});

test("a hollow compensation object (board didn't opt in) yields all-null comp", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.equal(out.compMin, null);
  assert.equal(out.compMax, null);
  assert.equal(out.compCurrency, null);
  assert.equal(out.compInterval, null);
});

test("a missing compensation key (no includeCompensation param) yields all-null comp", () => {
  const noComp = { ...salaried } as Record<string, unknown>;
  delete noComp.compensation;
  const out = normalizeAshby(noComp, { company: "ramp" })!;
  assert.equal(out.compMin, null);
  assert.equal(out.compInterval, null);
});

test("publishedAt (ISO-8601 string) converts to the correct Date", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.equal(out.publishedAt?.toISOString(), "2026-08-14T19:05:18.297Z");
});

test("location and department map from the flat strings", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.equal(out.location, "San Francisco, California");
  assert.equal(out.department, "Early Career");
});

test("descriptionPlain is used as-is — no leftover HTML tags", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.doesNotMatch(out.descriptionPlain, /<[a-z][^>]*>/i);
});

test("descriptionHtml keeps real markup", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.match(out.descriptionHtml, /<[a-z][^>]*>/i);
});

test("url is jobUrl (the posting page), not applyUrl (the form)", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.equal(out.url, intern.jobUrl);
});

test("applicationDeadline is always null — not present on Ashby's posting object", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.equal(out.applicationDeadline, null);
});

test("isListed: false drops the job — an unlisted posting must not enter the hub", () => {
  assert.equal(normalizeAshby({ ...intern, isListed: false }, { company: "notion" }), null);
});

test("duplicateKeys starts empty — only dedup.ts ever populates it", () => {
  const out = normalizeAshby(intern, { company: "notion" })!;
  assert.deepEqual(out.duplicateKeys, []);
});
