import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLeverToken, mineFirstCrawlWithSignal } from "./lever.js";

// ── extractLeverToken ───────────────────────────────────────────────────────────────────

test("extracts token from a board root URL", () => {
  assert.equal(extractLeverToken("https://jobs.lever.co/palantir"), "palantir");
});

test("extracts token from a posting URL (token/postingId)", () => {
  assert.equal(
    extractLeverToken("https://jobs.lever.co/palantir/1a2b3c4d-5e6f-7890-abcd-ef1234567890"),
    "palantir",
  );
});

test("extracts token from an apply URL (deeper path)", () => {
  assert.equal(
    extractLeverToken("https://jobs.lever.co/palantir/1a2b3c4d/apply"),
    "palantir",
  );
});

test("lowercases tokens so casing variants dedupe", () => {
  assert.equal(extractLeverToken("https://jobs.lever.co/Palantir"), "palantir");
});

test("keeps dotted tokens — real boards use them (close.io)", () => {
  assert.equal(extractLeverToken("https://jobs.lever.co/close.io/some-posting"), "close.io");
});

test("returns null for host root", () => {
  assert.equal(extractLeverToken("https://jobs.lever.co/"), null);
});

test("returns null for reserved well-known files", () => {
  assert.equal(extractLeverToken("https://jobs.lever.co/robots.txt"), null);
  assert.equal(extractLeverToken("https://jobs.lever.co/favicon.ico"), null);
});

test("returns null for other hosts (including the EU host, deliberately unsupported)", () => {
  assert.equal(extractLeverToken("https://jobs.eu.lever.co/diabolocom"), null);
  assert.equal(extractLeverToken("https://boards.greenhouse.io/stripe"), null);
});

test("returns null for malformed URLs instead of throwing", () => {
  assert.equal(extractLeverToken("not a url"), null);
});

// ── mineFirstCrawlWithSignal ────────────────────────────────────────────────────────────

const tokens = (n: number): string[] => Array.from({ length: n }, (_, i) => `co${i}`);

// Fake miner: crawl id -> canned token list (empty = robots-only crawl).
const fakeMine =
  (yields: Record<string, number>) =>
  async (crawlId: string, targetCount?: number): Promise<string[]> => {
    const all = tokens(yields[crawlId] ?? 0);
    return targetCount ? all.slice(0, targetCount) : all;
  };

test("skips robots-only crawls and returns the first crawl with signal", async () => {
  const result = await mineFirstCrawlWithSignal(
    ["cc-new-1", "cc-new-2", "cc-rich", "cc-older-richer"],
    undefined,
    fakeMine({ "cc-new-1": 0, "cc-new-2": 0, "cc-rich": 1500, "cc-older-richer": 1800 }),
  );
  // First crawl reaching the threshold wins — it does NOT keep walking for a bigger one.
  assert.equal(result.length, 1500);
});

test("a capped run accepts the first crawl that satisfies the cap", async () => {
  const result = await mineFirstCrawlWithSignal(
    ["cc-dead", "cc-rich"],
    5,
    fakeMine({ "cc-dead": 0, "cc-rich": 1500 }),
  );
  assert.equal(result.length, 5);
});

test("returns the largest yield when no crawl reaches the signal threshold", async () => {
  const result = await mineFirstCrawlWithSignal(
    ["cc-a", "cc-b", "cc-c"],
    undefined,
    fakeMine({ "cc-a": 2, "cc-b": 9, "cc-c": 4 }),
  );
  assert.equal(result.length, 9); // best-effort beats returning nothing
});

test("returns empty when every crawl is empty", async () => {
  const result = await mineFirstCrawlWithSignal(["cc-a", "cc-b"], undefined, fakeMine({}));
  assert.deepEqual(result, []);
});
