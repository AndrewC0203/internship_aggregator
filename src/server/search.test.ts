import { test } from "node:test";
import assert from "node:assert/strict";
import { sortGroups, assembleCards, mergeGroups, type RoleGroup, type FetchedVariant } from "./search.js";

// Card grouping (Decision 28) pure parts: group ordering decides pagination slices, card
// assembly decides what a card claims about its role — both testable without a DB, same
// bar as the pipeline stages.

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

const g = (company: string, title: string, seen: number, pub: number | null): RoleGroup => ({
  company,
  title,
  maxFirstSeen: day(seen),
  maxPublished: pub === null ? null : day(pub),
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
    { company: "Graphcore", title: "Build Engineer ", maxFirstSeen: day(2), maxPublished: null },
    { company: "Graphcore", title: "Build Engineer", maxFirstSeen: day(7), maxPublished: day(3) },
    { company: "Other", title: "Build Engineer", maxFirstSeen: day(1), maxPublished: null },
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
    { company: "Graphcore", title: "Build Engineer ", maxFirstSeen: day(2), maxPublished: null },
    { company: "Graphcore", title: "Build Engineer", maxFirstSeen: day(7), maxPublished: null },
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
