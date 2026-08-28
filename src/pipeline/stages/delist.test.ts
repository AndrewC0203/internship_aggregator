import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBoardCompany, delistStaleForBoard } from "./delist.js";
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
