import { test } from "node:test";
import assert from "node:assert/strict";
import { filterInternships } from "./filter.js";
import type { NormalizedListing } from "../types.js";

// These tests pin the load-bearing safety rule of Decision 13:
//
//   a regex reject must NEVER become a seen_listings row.
//
// `newRejects` is the only channel out of this stage that persist() writes to seen_listings,
// and partitionBySeen() never re-checks that table — so anything that leaks into newRejects
// is dropped permanently and unauditably (the table is key-only, so there is no title to
// review later). Not recording regex drops is what keeps a reject-router bug reversible: fix
// the regex, and the listing is re-evaluated on the very next run.
//
// These run WITHOUT a live Ollama or database on purpose. Every fixture below is resolved by
// one of the two regex routers, so no classify() call is ever made and no DB is touched — if
// a future change lets one of these reach the model, the suite will hang or error loudly,
// which is itself a useful signal.

let n = 0;
const listing = (title: string, descriptionPlain = "no experience minimum stated here"): NormalizedListing => ({
  source: "greenhouse",
  sourceExternalId: `ext-${++n}`,
  company: "Acme Corp",
  title,
  descriptionHtml: "<p>irrelevant — these fixtures never reach the model</p>",
  descriptionPlain,
  location: null,
  department: null,
  employmentType: null,
  workplaceType: null,
  compMin: null,
  compMax: null,
  compCurrency: null,
  compInterval: null,
  publishedAt: null,
  applicationDeadline: null,
  url: "https://example.com/job",
  duplicateKeys: [],
});

// Titles the reject-router drops (no early-career signal, clear seniority / non-CS function).
const REGEX_REJECTED = [
  "Senior Software Engineer",
  "Account Executive",
  "Enterprise Sales Manager",
  "Director of Engineering",
  "Payroll Specialist",
];

// Titles the accept-router fast-tracks (CS token AND intern/co-op token).
const REGEX_ACCEPTED = ["Software Engineering Intern", "Data Science Co-op"];

test("title-rejected listings never reach newRejects — the Decision 13 invariant", async () => {
  const { keeps, newRejects, titleDropped } = await filterInternships(
    REGEX_REJECTED.map((t) => listing(t)),
  );

  assert.equal(titleDropped, REGEX_REJECTED.length, "all fixtures should be title-dropped");
  assert.deepEqual(
    newRejects,
    [],
    "regex drops must NOT flow to newRejects — persist() would write them to seen_listings, " +
      "making the drop permanent and unauditable",
  );
  assert.deepEqual(keeps, [], "none of these fixtures are keeps");
});

test("experience-dropped listings never reach newRejects either — Decision 14", async () => {
  // Titles that survive the reject-router, so the experience filter is what stops them.
  const { keeps, newRejects, titleDropped, yoeDropped } = await filterInternships([
    listing("Data Analyst", "Experience: 2+ years in data or product analytics."),
    listing("Researcher", "2+ years of UX or other social science research experience"),
  ]);

  assert.equal(yoeDropped, 2, "both state a minimum above the cutoff");
  assert.equal(titleDropped, 0, "neither title is rejectable on its own");
  assert.deepEqual(newRejects, [], "experience drops must stay unrecorded, same as title drops");
  assert.deepEqual(keeps, []);
});

// NOTE: the "states 0 years, must NOT be dropped" case is deliberately NOT tested here.
// "Junior Engineer" survives both routers, so at filter level it would fall through to a real
// classify() call and break this file's no-network guarantee. The behaviour is pinned in
// experience.test.ts instead ("'0-3 years' has a minimum of 0"), where it is a pure function.

test("accept-router keeps and regex drops coexist without cross-contamination", async () => {
  const { keeps, newRejects, titleDropped } = await filterInternships(
    [...REGEX_ACCEPTED, ...REGEX_REJECTED].map((t) => listing(t)),
  );

  assert.equal(keeps.length, REGEX_ACCEPTED.length);
  assert.equal(titleDropped, REGEX_REJECTED.length);
  assert.deepEqual(newRejects, [], "still nothing to persist as a reject");
});

test("accept-router wins over the experience filter — an intern posting is kept regardless", async () => {
  // Ordering is deliberate: at a cutoff of 0, an incidental "1 year program" in the body would
  // otherwise drop a genuine internship.
  const { keeps, yoeDropped } = await filterInternships([
    listing("Software Engineering Intern", "This is a 1 year program with 2+ years preferred."),
  ]);

  assert.equal(keeps.length, 1, "the accept-router should fast-track this before the YOE check");
  assert.equal(yoeDropped, 0);
});

test("accept-router keeps carry a non-null opportunityType", async () => {
  const { keeps } = await filterInternships(REGEX_ACCEPTED.map((t) => listing(t)));

  assert.deepEqual(
    keeps.map((k) => k.opportunityType),
    ["internship", "co_op"],
  );
});

test("accept-router keeps get a title-derived csField (no model call) — Decision 16", async () => {
  const { keeps } = await filterInternships(REGEX_ACCEPTED.map((t) => listing(t)));

  assert.deepEqual(
    keeps.map((k) => k.csField),
    ["swe", "data"],
  );
});

test("an empty batch is a no-op", async () => {
  const { keeps, newRejects, titleDropped, yoeDropped } = await filterInternships([]);

  assert.deepEqual(keeps, []);
  assert.deepEqual(newRejects, []);
  assert.equal(titleDropped, 0);
  assert.equal(yoeDropped, 0);
});

test("every input lands in exactly one bucket — nothing is silently lost", async () => {
  const input = [
    ...REGEX_ACCEPTED.map((t) => listing(t)),
    ...REGEX_REJECTED.map((t) => listing(t)),
    listing("Data Analyst", "Experience: 2+ years in data or product analytics."),
  ];
  const { keeps, newRejects, titleDropped, yoeDropped } = await filterInternships(input);

  // With no model in play, every input must land in exactly one bucket. (In a real run the sum
  // can be less than input.length — a classify() failure is deliberately dropped from all
  // buckets so the listing stays unseen and retries next run.)
  assert.equal(
    keeps.length + newRejects.length + titleDropped + yoeDropped,
    input.length,
  );
  assert.equal(yoeDropped, 1, "the Data Analyst fixture is the experience drop");
});
