import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryableOllamaError, withOllamaRetry, OllamaError } from "./ollama.js";

// Mirrors src/discovery/retry.test.ts — same shape (classifier + retry-wrapper tests), applied
// to OllamaError instead of DiscoveryFetchError. See the comment in ollama.ts for why this is a
// separate copy rather than a shared helper.

// ── isRetryableOllamaError: the transient/fatal classification ─────────────────────────────

test("retryable: network/timeout error (no status)", () => {
  assert.equal(isRetryableOllamaError(new OllamaError("timed out")), true);
});

test("retryable: 429 and every 5xx", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableOllamaError(new OllamaError("x", status)), true, `status ${status}`);
  }
});

test("fatal: 4xx that isn't 429", () => {
  for (const status of [400, 404]) {
    assert.equal(isRetryableOllamaError(new OllamaError("x", status)), false, `status ${status}`);
  }
});

test("fatal: a non-OllamaError is never retried (e.g. a JSON-parse bug)", () => {
  assert.equal(isRetryableOllamaError(new Error("Unexpected token in JSON")), false);
  assert.equal(isRetryableOllamaError("boom"), false);
  assert.equal(isRetryableOllamaError(null), false);
});

// ── withOllamaRetry: attempts, backoff, outcomes ────────────────────────────────────────────

const noopSleep = async () => {};

test("returns immediately on success — fn called once, no sleeps", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await withOllamaRetry(
    async () => {
      calls++;
      return "ok";
    },
    { retries: 4, baseMs: 10, sleepFn: async (ms) => void delays.push(ms) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("retries transient failures then succeeds — one bad Ollama call doesn't lose the listing", async () => {
  let calls = 0;
  const result = await withOllamaRetry(
    async () => {
      calls++;
      if (calls < 3) throw new OllamaError("503", 503);
      return "recovered";
    },
    { retries: 4, baseMs: 10, sleepFn: noopSleep },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3); // failed twice, succeeded on the third
});

test("gives up after retries are exhausted and throws the last error", async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(
    () =>
      withOllamaRetry(
        async () => {
          calls++;
          throw new OllamaError("still 503", 503);
        },
        { retries: 3, baseMs: 10, sleepFn: async (ms) => void delays.push(ms) },
      ),
    (err: unknown) => err instanceof OllamaError && err.status === 503,
  );
  assert.equal(calls, 4); // 1 initial + 3 retries
  assert.deepEqual(delays, [10, 20, 40]); // exponential backoff: base * 2^attempt
});

test("does NOT retry a fatal error — throws immediately after one attempt", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withOllamaRetry(
        async () => {
          calls++;
          throw new OllamaError("bad schema", 400);
        },
        { retries: 4, baseMs: 10, sleepFn: noopSleep },
      ),
    (err: unknown) => err instanceof OllamaError && err.status === 400,
  );
  assert.equal(calls, 1); // no retries on a fatal error
});

test("respects a custom retry count", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withOllamaRetry(
        async () => {
          calls++;
          throw new OllamaError("timeout");
        },
        { retries: 1, baseMs: 5, sleepFn: noopSleep },
      ),
  );
  assert.equal(calls, 2); // 1 initial + 1 retry
});
