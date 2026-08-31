import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchLever, LeverFetchError } from "./fetch.js";

// These tests pin the pagination + envelope contract that live capture (Palantir,
// 2026-08-31) forced a correction on: the response is a BARE array (research/
// ats-field-reference.md previously described a wrapped-object/offset/total shape that
// doesn't exist), pagination is skip/limit with no total field, and there is no single
// whole-board ETag for a paginated fetch (see fetch.ts's comment on why priorEtag is
// accepted but never sent).

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

test("a single short page (< limit) returns its jobs and stops", async () => {
  const calls = mockFetch(() => jsonResponse([{ id: "a" }, { id: "b" }]));

  const result = await fetchLever("acme");

  assert.equal(calls.length, 1);
  assert.deepEqual(result, { kind: "ok", jobs: [{ id: "a" }, { id: "b" }], etag: null });
});

test("mode=json and skip/limit are sent as query params", async () => {
  const calls = mockFetch(() => jsonResponse([]));

  await fetchLever("acme");

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("mode"), "json");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("skip"), "0");
});

test("a full page (== limit) triggers a second request with skip advanced", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}` }));
  const page2 = [{ id: "p2-0" }];
  let call = 0;
  const calls = mockFetch(() => jsonResponse(call++ === 0 ? page1 : page2));

  const result = await fetchLever("acme");

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("skip"), "100");
  assert.equal(result.kind === "ok" && result.jobs.length, 101);
});

test("priorEtag is never sent — Lever's ETag is per-page, not whole-board", async () => {
  const calls = mockFetch(() => jsonResponse([]));

  await fetchLever("acme", 'W/"some-prior-etag"');

  assert.equal(new Headers(calls[0].init?.headers).has("If-None-Match"), false);
});

test("the returned etag is always null, even if a page sends one", async () => {
  const result = await (async () => {
    mockFetch(() => jsonResponse([{ id: "a" }], 'W/"page-etag"'));
    return fetchLever("acme");
  })();

  assert.equal(result.kind === "ok" && result.etag, null);
});

test("a non-array response body throws instead of being treated as zero jobs", async () => {
  mockFetch(() => jsonResponse({ ok: false, error: "Document not found" }));

  await assert.rejects(() => fetchLever("nonexistent-company"), LeverFetchError);
});

test("non-200 errors throw with status attached", async () => {
  mockFetch(() => new Response("gone", { status: 404, statusText: "Not Found" }));

  await assert.rejects(
    () => fetchLever("acme"),
    (err: unknown) => err instanceof LeverFetchError && err.status === 404,
  );
});

test("a board that never returns a short page throws rather than looping forever", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `x-${i}` }));
  mockFetch(() => jsonResponse(fullPage));

  await assert.rejects(() => fetchLever("infinite-board"), LeverFetchError);
});
