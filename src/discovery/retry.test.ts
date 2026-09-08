import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableCdxError,
  withCdxRetry,
  DiscoveryFetchError,
} from "./cdx.js";

// ── isRetryableCdxError: the transient/fatal classification ────────────────────────────────

test("retryable: network/timeout error (no status)", () => {
  assert.equal(isRetryableCdxError(new DiscoveryFetchError("timed out")), true);
});

test("retryable: 429 and every 5xx", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableCdxError(new DiscoveryFetchError("x", status)), true, `status ${status}`);
  }
});

test("fatal: 4xx that isn't 429", () => {
  for (const status of [400, 403, 404]) {
    assert.equal(isRetryableCdxError(new DiscoveryFetchError("x", status)), false, `status ${status}`);
  }
});

test("fatal: a non-DiscoveryFetchError is never retried", () => {
  assert.equal(isRetryableCdxError(new Error("some bug")), false);
  assert.equal(isRetryableCdxError("boom"), false);
  assert.equal(isRetryableCdxError(null), false);
});

// ── withCdxRetry: attempts, backoff, outcomes ──────────────────────────────────────────────

const noopSleep = async () => {};

test("returns immediately on success — fn called once, no sleeps", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await withCdxRetry(
    async () => {
      calls++;
      return "ok";
    },
    "test",
    { retries: 4, baseMs: 10, sleepFn: async (ms) => void delays.push(ms) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("retries transient failures then succeeds", async () => {
  let calls = 0;
  const result = await withCdxRetry(
    async () => {
      calls++;
      if (calls < 3) throw new DiscoveryFetchError("502", 502);
      return "recovered";
    },
    "test",
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
      withCdxRetry(
        async () => {
          calls++;
          throw new DiscoveryFetchError("still 503", 503);
        },
        "test",
        { retries: 3, baseMs: 10, sleepFn: async (ms) => void delays.push(ms) },
      ),
    (err: unknown) => err instanceof DiscoveryFetchError && err.status === 503,
  );
  assert.equal(calls, 4); // 1 initial + 3 retries
  assert.deepEqual(delays, [10, 20, 40]); // exponential backoff: base * 2^attempt
});

test("does NOT retry a fatal error — throws immediately after one attempt", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withCdxRetry(
        async () => {
          calls++;
          throw new DiscoveryFetchError("404", 404);
        },
        "test",
        { retries: 4, baseMs: 10, sleepFn: noopSleep },
      ),
    (err: unknown) => err instanceof DiscoveryFetchError && err.status === 404,
  );
  assert.equal(calls, 1); // no retries on a fatal error
});

test("respects a custom retry count", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withCdxRetry(
        async () => {
          calls++;
          throw new DiscoveryFetchError("timeout");
        },
        "test",
        { retries: 1, baseMs: 5, sleepFn: noopSleep },
      ),
  );
  assert.equal(calls, 2); // 1 initial + 1 retry
});
