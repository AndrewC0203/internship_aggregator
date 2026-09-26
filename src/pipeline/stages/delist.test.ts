import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBoardCompany, delistStaleForBoard, delistStaleForSource } from "./delist.js";
import type { DelistRepo } from "./delist.js";
import type { NormalizedListing } from "../types.js";

let n = 0;
const listing = (overrides: Partial<NormalizedListing> = {}): NormalizedListing => ({
  source: "greenhouse",
  sourceExternalId: `ext-${++n}`,
  company: "Acme Corp",
  title: "Software Engineering Intern",
  descriptionHtml: "<p>irrelevant</p>",
  descriptionPlain: "irrelevant",
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
  ...overrides,
});

function fakeRepo(): DelistRepo & { calls: Array<{ source: string; company: string; seenExternalIds: string[] }> } {
  const calls: Array<{ source: string; company: string; seenExternalIds: string[] }> = [];
  return {
    calls,
    async delistMissing({ source, company, seenExternalIds }) {
      calls.push({ source, company, seenExternalIds });
      // Pretend exactly one row would have matched "isListed AND not in seenExternalIds".
      return 1;
    },
    async delistMissingBySource() {
      throw new Error("source-scoped path must not be used by company-scoped delisting");
    },
  };
}

test("deriveBoardCompany: a single distinct company resolves", () => {
  const listings = [listing({ company: "Acme Corp" }), listing({ company: "Acme Corp" })];
  assert.equal(deriveBoardCompany(listings), "Acme Corp");
});

test("deriveBoardCompany: an empty board has no company to derive", () => {
  assert.equal(deriveBoardCompany([]), null);
});

test("deriveBoardCompany: multiple distinct companies is ambiguous, not a guess", () => {
  const listings = [listing({ company: "Acme Corp" }), listing({ company: "Acme Corp Inc" })];
  assert.equal(deriveBoardCompany(listings), null);
});

test("delistStaleForBoard: uses the freshly-derived company and this run's seen ids", async () => {
  const repo = fakeRepo();
  const listings = [
    listing({ company: "Acme Corp", sourceExternalId: "101" }),
    listing({ company: "Acme Corp", sourceExternalId: "102" }),
  ];
  const result = await delistStaleForBoard("greenhouse", listings, null, repo);

  assert.equal(repo.calls.length, 1);
  assert.deepEqual(repo.calls[0], {
    source: "greenhouse",
    company: "Acme Corp",
    seenExternalIds: ["101", "102"],
  });
  assert.equal(result.delistedCount, 1);
  assert.equal(result.resolvedCompany, "Acme Corp");
});

test("delistStaleForBoard: falls back to the cached company when this crawl is empty", async () => {
  const repo = fakeRepo();
  const result = await delistStaleForBoard("greenhouse", [], "Acme Corp", repo);

  assert.equal(repo.calls.length, 1);
  assert.deepEqual(repo.calls[0], {
    source: "greenhouse",
    company: "Acme Corp",
    seenExternalIds: [],
  });
  // Falling back to a cached value is not new information about this board — the caller must
  // not overwrite CrawlTarget.company with it.
  assert.equal(result.resolvedCompany, null);
});

test("delistStaleForBoard: no fresh and no cached company is a no-op, not a guess", async () => {
  const repo = fakeRepo();
  const result = await delistStaleForBoard("greenhouse", [], null, repo);

  assert.equal(repo.calls.length, 0);
  assert.deepEqual(result, { delistedCount: 0, resolvedCompany: null });
});

test("delistStaleForBoard: ambiguous multi-company crawl is a no-op even with a cached fallback", async () => {
  // Two distinct companies in one board's response should never happen in practice (one
  // Greenhouse token = one company's board), but if discovery data were ever wrong, this
  // crawl's data is DIRTY — falling back to a stale cache would mean trusting old information
  // over a present signal that something is broken, and risking a delist scoped to the wrong
  // company. Ambiguous must be a hard no-op: no delist call, no cache fallback, no cache write.
  const repo = fakeRepo();
  const listings = [listing({ company: "Acme Corp" }), listing({ company: "Acme Corp Inc" })];
  const result = await delistStaleForBoard("greenhouse", listings, "Acme Corp", repo);

  assert.equal(repo.calls.length, 0);
  assert.deepEqual(result, { delistedCount: 0, resolvedCompany: null });
});

// ---- Source-scoped delisting (Decision 38): the simplify "board" is one file spanning ----
// ---- hundreds of companies, so the company anchor can't scope it — the source does.   ----

function fakeSourceRepo(): DelistRepo & {
  sourceCalls: Array<{ source: string; seenExternalIds: string[] }>;
} {
  const sourceCalls: Array<{ source: string; seenExternalIds: string[] }> = [];
  return {
    sourceCalls,
    async delistMissing() {
      throw new Error("company-scoped path must not be used");
    },
    async delistMissingBySource({ source, seenExternalIds }) {
      sourceCalls.push({ source, seenExternalIds });
      return 2;
    },
  };
}

test("source-scoped: rows of the source absent from a successful crawl are delisted", async () => {
  const repo = fakeSourceRepo();
  const crawled = [
    listing({ source: "simplify", sourceExternalId: "a" }),
    listing({ source: "simplify", sourceExternalId: "b" }),
  ];

  const { delistedCount } = await delistStaleForSource("simplify", crawled, 1, repo);

  assert.equal(delistedCount, 2);
  assert.deepEqual(repo.sourceCalls, [{ source: "simplify", seenExternalIds: ["a", "b"] }]);
});

test("source-scoped: refuses to act when the source has more than one active target", async () => {
  // Two simplify repos would each see only their own file's actives — an absence-delist
  // scoped by source would let repo A's crawl delist repo B's listings. Until listings
  // carry a board discriminator, >1 active target makes this delist unsound: hard no-op.
  const repo = fakeSourceRepo();

  const { delistedCount } = await delistStaleForSource(
    "simplify",
    [listing({ source: "simplify" })],
    2,
    repo,
  );

  assert.equal(delistedCount, 0);
  assert.deepEqual(repo.sourceCalls, []);
});

test("source-scoped: an empty successful crawl delists the source's whole set (zero grace)", async () => {
  const repo = fakeSourceRepo();

  const { delistedCount } = await delistStaleForSource("simplify", [], 1, repo);

  assert.equal(delistedCount, 2);
  assert.deepEqual(repo.sourceCalls, [{ source: "simplify", seenExternalIds: [] }]);
});
