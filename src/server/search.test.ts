import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortGroups, assembleCards, mergeGroups, parseParams, buildWhere,
  searchParamsToSql, groupRanked,
  type RoleGroup, type FetchedVariant, type RankedFetchedVariant,
} from "./search.js";
import { curatedSelectiveCompanies } from "../recommend/labels.js";

// Card grouping (Decision 28) pure parts: group ordering decides pagination slices, card
// assembly decides what a card claims about its role — both testable without a DB, same
// bar as the pipeline stages.

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

const g = (
  company: string,
  title: string,
  seen: number,
  pub: number | null,
  deadline: number | null = null,
): RoleGroup => ({
  company,
  title,
  maxFirstSeen: day(seen),
  maxPublished: pub === null ? null : day(pub),
  minDeadline: deadline === null ? null : day(deadline),
  rawKeys: [{ company, title }],
});

const v = (over: Partial<FetchedVariant> & { id: number; company: string; title: string }): FetchedVariant => ({
  location: null, locUsStates: [], locCountries: [],
  opportunityType: "new_grad", csField: "swe",
  gradYearMin: null, gradYearMax: null, citizenshipStatus: null, degreeStatus: null,
  url: `https://x/${over.id}`, firstSeenAt: day(1), publishedAt: null,
  applicationDeadline: null, isNew: false, status: null, note: null,
  ...over,
});

test("mergeGroups folds whitespace twins under the trimmed key, keeping raw spellings", () => {
  // Real case: Graphcore titles stored with trailing spaces split into separate SQL groups.
  const merged = mergeGroups([
    { company: "Graphcore", title: "Build Engineer ", maxFirstSeen: day(2), maxPublished: null, minDeadline: null },
    { company: "Graphcore", title: "Build Engineer", maxFirstSeen: day(7), maxPublished: day(3), minDeadline: null },
    { company: "Other", title: "Build Engineer", maxFirstSeen: day(1), maxPublished: null, minDeadline: null },
  ]);
  assert.equal(merged.length, 2);
  const gc = merged.find((m) => m.company === "Graphcore");
  assert.equal(gc?.title, "Build Engineer");
  // Sort keys take the max across spellings; both raw spellings kept for the row fetch.
  assert.equal(gc?.maxFirstSeen.getTime(), day(7).getTime());
  assert.equal(gc?.maxPublished?.getTime(), day(3).getTime());
  assert.deepEqual(gc?.rawKeys.map((k) => k.title).sort(), ["Build Engineer", "Build Engineer "]);
});

test("assembleCards matches variants to groups on the trimmed key", () => {
  const merged = mergeGroups([
    { company: "Graphcore", title: "Build Engineer ", maxFirstSeen: day(2), maxPublished: null, minDeadline: null },
    { company: "Graphcore", title: "Build Engineer", maxFirstSeen: day(7), maxPublished: null, minDeadline: null },
  ]);
  const cards = assembleCards(merged, [
    v({ id: 1, company: "Graphcore", title: "Build Engineer ", firstSeenAt: day(2) }),
    v({ id: 2, company: "Graphcore", title: "Build Engineer", firstSeenAt: day(7) }),
  ]);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].variants.map((x) => x.id), [2, 1]);
});

test("first_seen sort: newest variant's date orders the card; name breaks ties", () => {
  const sorted = sortGroups(
    [g("Beta", "SWE", 3, null), g("Alpha", "SWE", 5, null), g("Gamma", "SWE", 5, null)],
    "first_seen",
  );
  assert.deepEqual(sorted.map((x) => x.company), ["Alpha", "Gamma", "Beta"]);
});

test("published sort: desc with nulls last, both regions name-tiebroken", () => {
  const sorted = sortGroups(
    [g("NoDate2", "b", 9, null), g("Old", "x", 1, 2), g("NoDate1", "a", 9, null), g("New", "x", 1, 8)],
    "published",
  );
  assert.deepEqual(sorted.map((x) => x.company), ["New", "Old", "NoDate1", "NoDate2"]);
});

test("deadline sort: future soonest-first, then no-deadline, then already-closed last", () => {
  // Fixed reference "now" (day 15) so the future/past bucketing never depends on wall-clock
  // time — a naive Date.now() here would make this test a time bomb, since day(10) below is
  // only "in the past" relative to a chosen now, not to whenever the suite happens to run.
  const now = day(15);
  const sorted = sortGroups(
    [
      g("NoDeadline2", "b", 9, null, null),
      g("SoonB", "x", 1, null, 20),
      g("NoDeadline1", "a", 9, null, null),
      g("SoonA", "x", 1, null, 20),
      g("Later", "x", 1, null, 25),
      g("AlreadyClosed", "x", 1, null, 10),
    ],
    "deadline",
    now,
  );
  assert.deepEqual(
    sorted.map((x) => x.company),
    ["SoonA", "SoonB", "Later", "NoDeadline1", "NoDeadline2", "AlreadyClosed"],
  );
});

test("company sort: company then title, ignoring dates", () => {
  const sorted = sortGroups(
    [g("Acme", "Zeta", 9, 9), g("Acme", "Alpha", 1, 1), g("AAA", "Mid", 5, 5)],
    "company",
  );
  assert.deepEqual(sorted.map((x) => `${x.company}/${x.title}`), ["AAA/Mid", "Acme/Alpha", "Acme/Zeta"]);
});

test("sortGroups does not mutate its input", () => {
  const input = [g("B", "t", 1, null), g("A", "t", 2, null)];
  sortGroups(input, "first_seen");
  assert.deepEqual(input.map((x) => x.company), ["B", "A"]);
});

test("assembleCards: one card per group in group order, variants newest-first", () => {
  const groups = [g("Palantir", "SWE Core", 9, null), g("Sezzle", "Intern", 5, null)];
  const cards = assembleCards(groups, [
    v({ id: 1, company: "Sezzle", title: "Intern", location: "Colombia", firstSeenAt: day(5) }),
    v({ id: 2, company: "Palantir", title: "SWE Core", location: "New York, NY", firstSeenAt: day(2) }),
    v({ id: 3, company: "Palantir", title: "SWE Core", location: "Palo Alto, CA", firstSeenAt: day(9) }),
  ]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].company, "Palantir");
  // Newest posting leads the card; the older geographic variant follows.
  assert.deepEqual(cards[0].variants.map((x) => x.id), [3, 2]);
  assert.deepEqual(cards[1].variants.map((x) => x.id), [1]);
});

test("assembleCards: card isNew when ANY variant is new; classification from newest", () => {
  const cards = assembleCards(
    [g("A", "t", 9, null)],
    [
      v({ id: 1, company: "A", title: "t", firstSeenAt: day(1), isNew: false, csField: "data" }),
      v({ id: 2, company: "A", title: "t", firstSeenAt: day(9), isNew: true, csField: "swe" }),
    ],
  );
  assert.equal(cards[0].isNew, true);
  assert.equal(cards[0].csField, "swe");
});

test("assembleCards: same-instant variants tie-break on id so re-renders are stable", () => {
  const cards = assembleCards(
    [g("A", "t", 1, null)],
    [
      v({ id: 1, company: "A", title: "t", firstSeenAt: day(1) }),
      v({ id: 2, company: "A", title: "t", firstSeenAt: day(1) }),
    ],
  );
  assert.deepEqual(cards[0].variants.map((x) => x.id), [2, 1]);
});

test("assembleCards: a group with no fetched rows is skipped, not rendered empty", () => {
  const cards = assembleCards(
    [g("Ghost", "t", 1, null), g("Real", "t", 1, null)],
    [v({ id: 1, company: "Real", title: "t" })],
  );
  assert.deepEqual(cards.map((c) => c.company), ["Real"]);
});

test("assembleCards: variants carry per-posting fields, not the grouping key", () => {
  const cards = assembleCards(
    [g("A", "t", 1, null)],
    [v({ id: 1, company: "A", title: "t", status: "applied", note: "asked ref" })],
  );
  const variant = cards[0].variants[0] as unknown as Record<string, unknown>;
  assert.equal(variant.status, "applied");
  assert.equal(variant.note, "asked ref");
  assert.ok(!("company" in variant) && !("title" in variant));
});

test("parseParams: workplace keeps only known enum values, drops junk", () => {
  assert.deepEqual(parseParams({ workplace: "remote,onsite,made_up" }).workplace, ["remote", "onsite"]);
  assert.equal(parseParams({ workplace: "made_up" }).workplace, undefined);
});

test("parseParams: selective is a plain boolean flag", () => {
  assert.equal(parseParams({ selective: "1" }).selective, true);
  assert.equal(parseParams({}).selective, false);
});

test("parseParams: sort accepts fit/deadline alongside the existing values, junk left undefined", () => {
  assert.equal(parseParams({ sort: "deadline" }).sort, "deadline");
  assert.equal(parseParams({ sort: "fit" }).sort, "fit");
  // Deliberately undefined, not defaulted to "first_seen" — runSearch() resolves the
  // default based on whether ranking is available, which parseParams can't know.
  assert.equal(parseParams({ sort: "bogus" }).sort, undefined);
  assert.equal(parseParams({}).sort, undefined);
});

test("buildWhere: workplace filter is an IN, omitted for its own facet count", () => {
  const p = parseParams({ workplace: "remote,hybrid" });
  const where = buildWhere(p) as { AND: Array<Record<string, unknown>> };
  assert.ok(where.AND.some((c) => JSON.stringify(c) === JSON.stringify({ workplaceType: { in: ["remote", "hybrid"] } })));
  const omitted = buildWhere(p, "workplace") as { AND: Array<Record<string, unknown>> };
  assert.ok(!omitted.AND.some((c) => "workplaceType" in c));
});

test("buildWhere: selective adds one case-insensitive OR per curated company", () => {
  const p = parseParams({ selective: "1" });
  const where = buildWhere(p) as { AND: Array<{ OR?: Array<{ company?: { equals: string; mode: string } }> }> };
  const clause = where.AND.find((c) => Array.isArray(c.OR) && c.OR[0]?.company);
  assert.equal(clause?.OR?.length, curatedSelectiveCompanies().length);
  assert.equal(clause?.OR?.[0]?.company?.mode, "insensitive");
});

test("buildWhere: selective omitted when the flag is absent", () => {
  const where = buildWhere(parseParams({})) as { AND: Array<{ OR?: unknown }> };
  assert.ok(!where.AND.some((c) => Array.isArray(c.OR) && (c.OR[0] as { company?: unknown })?.company));
});

// ── searchParamsToSql (Decision 34's raw-SQL twin of buildWhere) ────────────────────────
// Full row-for-row parity against buildWhere isn't unit-testable without a DB — verified
// live instead (curl both paths with the same filters, compare totals), consistent with
// this repo's existing boundary: DB-touching query logic is live-verified, not mocked.
// What IS testable here without a DB: each condition's SQL shape and param binding.

test("searchParamsToSql: always includes is_listed, one condition per answered facet", () => {
  const bare = searchParamsToSql(parseParams({}));
  assert.equal(bare.length, 1);
  assert.match(bare[0].sql, /is_listed/);

  const withType = searchParamsToSql(parseParams({ type: "internship" }));
  assert.equal(withType.length, 2);
  assert.match(withType[1].sql, /opportunity_type/);
});

test("searchParamsToSql: q becomes an ILIKE over title OR company, wildcarded", () => {
  const conds = searchParamsToSql(parseParams({ q: "quant" }));
  const qCond = conds.find((c) => /ILIKE/.test(c.sql));
  assert.ok(qCond);
  assert.deepEqual(qCond?.values, ["%quant%", "%quant%"]);
});

test("searchParamsToSql: status splits real values from \"none\" into a status IS NULL branch", () => {
  const conds = searchParamsToSql(parseParams({ status: "saved,none" }));
  const statusCond = conds.find((c) => /a\.status/.test(c.sql));
  assert.match(statusCond!.sql, /a\.status::text = ANY/);
  assert.match(statusCond!.sql, /a\.status IS NULL/);
});

test("searchParamsToSql: selective reuses the curated list via lower(trim(company)) = ANY", () => {
  const conds = searchParamsToSql(parseParams({ selective: "1" }));
  const selCond = conds.find((c) => /lower\(trim\(company\)\)/.test(c.sql));
  assert.deepEqual(selCond?.values[0], curatedSelectiveCompanies());
});

// ── groupRanked (fit-sort grouping, one pass over already-fetched+scored rows) ──────────

const rv = (over: Partial<RankedFetchedVariant> & { id: number; company: string; title: string; score: number }): RankedFetchedVariant => ({
  location: null, locUsStates: [], locCountries: [],
  gradYearMin: null, gradYearMax: null, citizenshipStatus: null, degreeStatus: null,
  opportunityType: "new_grad", csField: "swe",
  url: `https://x/${over.id}`, firstSeenAt: day(1), publishedAt: null,
  applicationDeadline: null, isNew: false, status: null, note: null,
  ...over,
});

test("groupRanked: folds same-role variants, bestScore is the max across them", () => {
  const groups = groupRanked([
    rv({ id: 1, company: "Palantir", title: "SWE", score: 0.7, location: "NY" }),
    rv({ id: 2, company: "Palantir", title: "SWE", score: 0.9, location: "CA" }),
    rv({ id: 3, company: "Stripe", title: "SWE", score: 0.8 }),
  ]);
  assert.equal(groups.length, 2);
  const palantir = groups.find((g) => g.company === "Palantir");
  assert.equal(palantir?.bestScore, 0.9);
  assert.equal(palantir?.variants.length, 2);
});

test("groupRanked: folds whitespace twins under the trimmed key, same as mergeGroups", () => {
  const groups = groupRanked([
    rv({ id: 1, company: "Graphcore", title: "Build Engineer ", score: 0.5 }),
    rv({ id: 2, company: "Graphcore", title: "Build Engineer", score: 0.6 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].variants.length, 2);
});

test("parseParams: page/per must be integers — 2.5 and Infinity fall to defaults, not the UI", () => {
  // Number("2.5") survives `|| 1` and Math.max, so pre-fix the pager rendered "PAGE 2.5"
  // and PREV linked to ?page=1.5; ?page=Infinity looped forever (Infinity - 1 === Infinity).
  assert.equal(parseParams({ page: "2.5" }).page, 1);
  assert.equal(parseParams({ page: "Infinity" }).page, 1);
  assert.equal(parseParams({ page: "3" }).page, 3);
  assert.equal(parseParams({ per: "2.5" }).per, 50);
  assert.equal(parseParams({ per: "25" }).per, 25);
});
