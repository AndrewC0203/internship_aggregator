import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchSimplify, SimplifyFetchError } from "./fetch.js";

// Mirrors greenhouse/fetch.test.ts: globalThis.fetch is mocked, no network. The
// simplify-specific contract on top of the shared Decision 23 behaviors:
//   - token is the GitHub repo slug; the URL targets the repo's machine-readable
//     .github/scripts/listings.json on the `dev` branch (the branch Simplify maintains),
//   - jobs = ACTIVE + VISIBLE entries only. The ATS fetchers return "the board's live set"
//     because the ATS API only serves live postings; Simplify's file retains dead entries
//     with active:false, so the fetch filters to preserve that same "present = live"
//     semantic — which is exactly what absence-based delisting reads (Decision 22/37).
const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/simplify.listings.sample.json", import.meta.url), "utf8"),
) as Array<Record<string, unknown>>;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response,
): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

const jsonResponse = (body: unknown, etag?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });

test("targets the repo's listings.json on the dev branch", async () => {
  const calls = mockFetch(() => jsonResponse([]));
  await fetchSimplify("SimplifyJobs/Summer2026-Internships");
  assert.equal(
    calls[0].url,
    "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
  );
});

test("returns only active+visible entries; inactive and invisible are excluded", async () => {
  mockFetch(() => jsonResponse(fixture, 'W/"abc"'));
  const result = await fetchSimplify("SimplifyJobs/Summer2026-Internships");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.jobs.length, 7); // fixture has 9 entries: 1 inactive, 1 invisible
  for (const job of result.jobs) {
    const j = job as { active: boolean; is_visible: boolean };
    assert.equal(j.active && j.is_visible, true);
  }
  assert.equal(result.etag, 'W/"abc"');
});

test("prior etag is sent as If-None-Match; a 304 comes back as not_modified", async () => {
  const calls = mockFetch(() => new Response(null, { status: 304 }));
  const result = await fetchSimplify("SimplifyJobs/Summer2026-Internships", 'W/"abc"');
  assert.equal(new Headers(calls[0].init?.headers).get("If-None-Match"), 'W/"abc"');
  assert.deepEqual(result, { kind: "not_modified" });
});

test("no prior etag sends no If-None-Match", async () => {
  const calls = mockFetch(() => jsonResponse([]));
  await fetchSimplify("SimplifyJobs/Summer2026-Internships");
  assert.equal(new Headers(calls[0].init?.headers).has("If-None-Match"), false);
});

test("non-array body is a fetch failure, never an empty result", async () => {
  mockFetch(() => jsonResponse({ oops: true }));
  await assert.rejects(
    fetchSimplify("SimplifyJobs/Summer2026-Internships"),
    (err: unknown) => err instanceof SimplifyFetchError,
  );
});

test("HTTP errors carry the status for the orchestrator's 429 handling", async () => {
  mockFetch(() => new Response("nope", { status: 429 }));
  await assert.rejects(
    fetchSimplify("SimplifyJobs/Summer2026-Internships"),
    (err: unknown) => err instanceof SimplifyFetchError && err.status === 429,
  );
});
