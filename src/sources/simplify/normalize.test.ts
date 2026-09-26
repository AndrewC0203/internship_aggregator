import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSimplify } from "./normalize.js";

// Fixture captured live 2026-09-25 from the SimplifyJobs Summer2026-Internships repo's
// .github/scripts/listings.json (research/simplify-source-measurements.md). Mixed picks
// covering every mapping this normalizer owns:
//   [0] Cresta (Greenhouse URL, single location)      — numeric-id alias parse
//   [1] Palantir (Lever URL ending in /apply)         — uuid alias parse behind a suffix
//   [2] Dryft (Ashby URL ending in /application)      — uuid alias parse behind a suffix
//   [3] Equifax (Workday URL)                         — no alias; the 81% uncrawlable case
//   [4] Prior Labs (Ashby, 3+ locations)              — multi-location join
//   [5] K1IM ("Does Not Offer Sponsorship")           — sponsorship → citizenshipStatus
//   [6] Hermeus (Lever URL with NO /apply suffix,
//       "U.S. Citizenship is Required")               — bare-uuid alias + citizenship map
//   [7] Hitachi (active: false)                       — fetch-layer concern, unused here
//   [8] Geneva Trading (is_visible: false)            — fetch-layer concern, unused here
const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/simplify.listings.sample.json", import.meta.url), "utf8"),
) as Array<Record<string, unknown>>;

const [greenhouse, leverApply, ashbyApp, workday, multiLoc, noSponsor, citizenship] = fixture;

test("identity fields map straight across", () => {
  const out = normalizeSimplify(greenhouse, {})!;
  assert.equal(out.source, "simplify");
  assert.equal(out.sourceExternalId, greenhouse.id);
  assert.equal(out.company, "Cresta");
  assert.equal(out.title, greenhouse.title);
  assert.equal(out.url, greenhouse.url);
});

test("single location passes through; multi-location joins with '; '", () => {
  assert.equal(normalizeSimplify(greenhouse, {})!.location, (greenhouse.locations as string[])[0]);
  const locs = multiLoc.locations as string[];
  assert.ok(locs.length >= 3);
  assert.equal(normalizeSimplify(multiLoc, {})!.location, locs.join("; "));
});

test("publishedAt comes from date_posted (unix seconds)", () => {
  const out = normalizeSimplify(greenhouse, {})!;
  assert.equal(out.publishedAt?.getTime(), (greenhouse.date_posted as number) * 1000);
});

test("synthetic description leads with the informative fields, provenance last", () => {
  const out = normalizeSimplify(greenhouse, {})!;
  assert.ok(out.descriptionPlain.startsWith(`Category: ${greenhouse.category as string}`));
  assert.ok(out.descriptionPlain.includes((greenhouse.locations as string[])[0]));
  assert.ok(out.descriptionPlain.includes("SimplifyJobs"));
  assert.ok(out.descriptionHtml.includes("<p>"));
});

test("every entry is pre-classified as an internship", () => {
  const out = normalizeSimplify(greenhouse, {})!;
  assert.equal(out.preclassified?.opportunityType, "internship");
});

test("category maps deterministically onto cs_field", () => {
  assert.equal(normalizeSimplify(greenhouse, {})!.preclassified?.csField, "ml_ai"); // AI/ML/Data
  assert.equal(normalizeSimplify(leverApply, {})!.preclassified?.csField, "swe"); // Software
  assert.equal(normalizeSimplify(citizenship, {})!.preclassified?.csField, "hardware_embedded"); // Hardware Engineering
  assert.equal(normalizeSimplify(noSponsor, {})!.preclassified?.csField, "ml_ai"); // Data Science, AI & ML
  assert.equal(
    normalizeSimplify({ ...greenhouse, category: "Basket Weaving" }, {})!.preclassified?.csField,
    null, // unknown category → abstain, never guess (Decision 16 posture)
  );
});

test("sponsorship maps onto citizenshipStatus; 'Other' means the repo said nothing", () => {
  assert.equal(normalizeSimplify(greenhouse, {})!.preclassified?.citizenshipStatus, null); // "Other"
  assert.equal(normalizeSimplify(noSponsor, {})!.preclassified?.citizenshipStatus, "no_sponsorship");
  assert.equal(
    normalizeSimplify(citizenship, {})!.preclassified?.citizenshipStatus,
    "us_citizen_required",
  );
  assert.equal(
    normalizeSimplify({ ...greenhouse, sponsorship: "Offers Sponsorship" }, {})!.preclassified
      ?.citizenshipStatus,
    "sponsorship_available",
  );
});

test("ATS-hosted URLs yield an alias key in duplicateKeys (Decision 39)", () => {
  assert.deepEqual(normalizeSimplify(greenhouse, {})!.duplicateKeys, [
    { source: "greenhouse", sourceExternalId: "5106468008" },
  ]);
  assert.deepEqual(normalizeSimplify(leverApply, {})!.duplicateKeys, [
    { source: "lever", sourceExternalId: "ac0dc094-2480-43c2-8495-26ade227ff4f" },
  ]);
  assert.deepEqual(normalizeSimplify(ashbyApp, {})!.duplicateKeys, [
    { source: "ashby", sourceExternalId: "3f1c261d-9b65-412b-9f17-34b8968bdd78" },
  ]);
  // Lever URL WITHOUT the /apply suffix parses identically.
  assert.deepEqual(normalizeSimplify(citizenship, {})!.duplicateKeys, [
    { source: "lever", sourceExternalId: "51378fa0-0327-45fd-9420-b6e7d8b56440" },
  ]);
});

test("Greenhouse embed-style URLs (gh_jid param / embed token) also yield the alias", () => {
  assert.deepEqual(
    normalizeSimplify({ ...greenhouse, url: "https://careers.acme.com/jobs?gh_jid=1234567" }, {})!
      .duplicateKeys,
    [{ source: "greenhouse", sourceExternalId: "1234567" }],
  );
  assert.deepEqual(
    normalizeSimplify(
      { ...greenhouse, url: "https://boards.greenhouse.io/embed/job_app?for=acme&token=7654321" },
      {},
    )!.duplicateKeys,
    [{ source: "greenhouse", sourceExternalId: "7654321" }],
  );
});

test("non-ATS URLs carry no alias", () => {
  assert.deepEqual(normalizeSimplify(workday, {})!.duplicateKeys, []);
});

test("missing identity fields drop the entry rather than guessing", () => {
  assert.equal(normalizeSimplify({ ...greenhouse, id: undefined }, {}), null);
  assert.equal(normalizeSimplify({ ...greenhouse, company_name: "  " }, {}), null);
  assert.equal(normalizeSimplify({ ...greenhouse, title: undefined }, {}), null);
  assert.equal(normalizeSimplify({ ...greenhouse, url: undefined }, {}), null);
  assert.equal(normalizeSimplify("not an object", {}), null);
});
