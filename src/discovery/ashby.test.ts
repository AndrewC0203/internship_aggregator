import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAshbyToken } from "./ashby.js";

// URL shapes verified against real CDX captures (CC-MAIN-2026-34, 2026-09-08):
// board root /{org}, posting /{org}/{uuid}, application /{org}/{uuid}/application, all
// frequently decorated with utm/ref query params from job-board aggregators.

test("extracts token from a board root URL", () => {
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/notion"), "notion");
});

test("extracts token from a posting URL (org/uuid)", () => {
  assert.equal(
    extractAshbyToken("https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245"),
    "ramp",
  );
});

test("extracts token from an application URL (deeper path)", () => {
  assert.equal(
    extractAshbyToken(
      "https://jobs.ashbyhq.com/1password/42e39877-8c7c-4f18-9d42-336777df1de9/application",
    ),
    "1password",
  );
});

test("query decorations (utm/ref/embed) don't affect the token", () => {
  assert.equal(
    extractAshbyToken(
      "https://jobs.ashbyhq.com/0x/2f585545-92f6-4954-ae52-a7ee86d45ea2?utm_source=Jump+Crypto+job+board&utm_medium=getro.com",
    ),
    "0x",
  );
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/11x/84dd760d?embed=js"), "11x");
});

test("tokens are lowercased so casing variants dedupe", () => {
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/Notion"), "notion");
});

test("reserved segments are not tokens", () => {
  // robots.txt-disallowed app routes (/api/, /meeting/, /b/) plus host-level well-known files.
  for (const path of ["api/foo", "meeting/xyz", "b/abc", "robots.txt", "favicon.ico", "sitemap.xml"]) {
    assert.equal(extractAshbyToken(`https://jobs.ashbyhq.com/${path}`), null, path);
  }
});

test("host root, wrong host, and malformed URLs yield null", () => {
  assert.equal(extractAshbyToken("https://jobs.ashbyhq.com/"), null);
  assert.equal(extractAshbyToken("https://jobs.lever.co/notion"), null);
  assert.equal(extractAshbyToken("not a url"), null);
});
