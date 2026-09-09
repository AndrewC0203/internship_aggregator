import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchAshby, AshbyFetchError } from "./fetch.js";

// These tests pin the contract verified live (Ramp + OpenAI boards, 2026-09-08): the
// response is a single UNPAGINATED `{ jobs, apiVersion }` envelope (Greenhouse-style, not
// Lever's bare array), and — unlike Lever — Ashby sends a WHOLE-BOARD weak ETag
// (`W/"job-board:..."`) that answers If-None-Match with a genuine 304. That makes Ashby the
// second source (after Greenhouse) where the Decision 23 conditional-fetch path is real.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response): Array<{ url: string; init?: RequestInit }> {
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

test("unwraps the { jobs, apiVersion } envelope and returns the jobs with the etag", async () => {
  mockFetch(() => jsonResponse({ jobs: [{ id: "a" }, { id: "b" }], apiVersion: 1 }, 'W/"job-board:abc"'));

  const result = await fetchAshby("acme");

  assert.deepEqual(result, {
    kind: "ok",
    jobs: [{ id: "a" }, { id: "b" }],
    etag: 'W/"job-board:abc"',
  });
});

test("requests includeCompensation=true", async () => {
  const calls = mockFetch(() => jsonResponse({ jobs: [] }));

  await fetchAshby("acme");

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("includeCompensation"), "true");
  assert.match(url.pathname, /\/posting-api\/job-board\/acme$/);
});

test("priorEtag is sent as If-None-Match — Ashby's ETag covers the whole board", async () => {
  const calls = mockFetch(() => jsonResponse({ jobs: [] }));

  await fetchAshby("acme", 'W/"job-board:prior"');

  assert.equal(new Headers(calls[0].init?.headers).get("If-None-Match"), 'W/"job-board:prior"');
});

test("a 304 answer becomes { kind: 'not_modified' }", async () => {
  mockFetch(() => new Response(null, { status: 304 }));

  const result = await fetchAshby("acme", 'W/"job-board:prior"');

  assert.deepEqual(result, { kind: "not_modified" });
});

test("no If-None-Match header is sent when priorEtag is absent", async () => {
  const calls = mockFetch(() => jsonResponse({ jobs: [] }));

  await fetchAshby("acme");

  assert.equal(new Headers(calls[0].init?.headers).has("If-None-Match"), false);
});

test("a missing jobs field throws instead of being treated as zero jobs", async () => {
  mockFetch(() => jsonResponse({ apiVersion: 1 }));

  await assert.rejects(() => fetchAshby("acme"), AshbyFetchError);
});

test("a non-array jobs field throws", async () => {
  mockFetch(() => jsonResponse({ jobs: "nope", apiVersion: 1 }));

  await assert.rejects(() => fetchAshby("acme"), AshbyFetchError);
});

test("non-200 errors throw with status attached (404 = no such board)", async () => {
  mockFetch(() => new Response("Not Found", { status: 404, statusText: "Not Found" }));

  await assert.rejects(
    () => fetchAshby("nonexistent-board"),
    (err: unknown) => err instanceof AshbyFetchError && err.status === 404,
  );
});

test("non-JSON response body throws", async () => {
  mockFetch(() => new Response("<html>oops</html>", { status: 200 }));

  await assert.rejects(() => fetchAshby("acme"), AshbyFetchError);
});
