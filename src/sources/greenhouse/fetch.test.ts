import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchGreenhouse, GreenhouseFetchError } from "./fetch.js";

// These tests pin the conditional-fetch contract (Decision 23) by mocking globalThis.fetch —
// no network. The load-bearing behaviors:
//   1. a 304 comes back as { kind: "not_modified" }, never as an empty jobs array (an empty
//      array is a REAL state — "board has zero postings" — that triggers delisting; conflating
//      the two would let an unchanged board wipe its own listings via Decision 22),
//   2. If-None-Match is sent exactly when a prior etag exists,
//   3. the etag is only ever captured from a fully-validated 200 response.

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

test("no prior etag: sends no If-None-Match, returns jobs + captured etag", async () => {
  const calls = mockFetch(() => jsonResponse({ jobs: [{ id: 1 }] }, 'W/"abc"'));

  const result = await fetchGreenhouse("acme");

  assert.equal(new Headers(calls[0].init?.headers).has("If-None-Match"), false);
  assert.deepEqual(result, { kind: "ok", jobs: [{ id: 1 }], etag: 'W/"abc"' });
});

test("prior etag is sent as If-None-Match", async () => {
  const calls = mockFetch(() => jsonResponse({ jobs: [] }, 'W/"def"'));

  await fetchGreenhouse("acme", 'W/"abc"');

  assert.equal(new Headers(calls[0].init?.headers).get("If-None-Match"), 'W/"abc"');
});

test("304 returns the not_modified shape, with no jobs field at all", async () => {
  mockFetch(() => new Response(null, { status: 304 }));

  const result = await fetchGreenhouse("acme", 'W/"abc"');

  assert.deepEqual(result, { kind: "not_modified" });
  assert.equal("jobs" in result, false);
});

test("a 200 without an etag header returns etag null (next crawl is unconditional)", async () => {
  mockFetch(() => jsonResponse({ jobs: [] }));

  const result = await fetchGreenhouse("acme");

  assert.deepEqual(result, { kind: "ok", jobs: [], etag: null });
});

test("an empty board is kind ok with jobs [], distinct from not_modified", async () => {
  // The delist stage treats this as "company pulled every posting" — it must stay
  // distinguishable from a 304 forever.
  mockFetch(() => jsonResponse({ jobs: [] }, 'W/"empty"'));

  const result = await fetchGreenhouse("acme");

  assert.equal(result.kind, "ok");
});

test("a malformed 200 still throws — its etag is never surfaced for storage", async () => {
  // If a broken payload's etag were stored, the NEXT crawl would 304 against a body we never
  // successfully processed, freezing the bad state in place.
  mockFetch(() => jsonResponse({ nope: true }, 'W/"poison"'));

  await assert.rejects(() => fetchGreenhouse("acme"), GreenhouseFetchError);
});

test("non-304 errors still throw with status attached", async () => {
  mockFetch(() => new Response("gone", { status: 404, statusText: "Not Found" }));

  await assert.rejects(
    () => fetchGreenhouse("acme", 'W/"abc"'),
    (err: unknown) => err instanceof GreenhouseFetchError && err.status === 404,
  );
});
