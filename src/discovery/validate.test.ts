import { test } from "node:test";
import assert from "node:assert/strict";
import { validateToken } from "./validate.js";
import type { BoardFetcher } from "./types.js";
import { GreenhouseFetchError } from "../sources/greenhouse/fetch.js";

// validateToken has no I/O of its own — it takes an injected BoardFetcher, so every branch
// is drivable with a fake. These fakes stand in for what a real fetch resolves/throws.

// Resolves to a jobs array of the given length.
const resolvesWith = (count: number): BoardFetcher => async () =>
  Array.from({ length: count }, (_, i) => ({ id: i }));

// Rejects with the given value (Error, error-like, or raw).
const rejectsWith = (err: unknown): BoardFetcher => async () => {
  throw err;
};

// ── Outcome: valid ────────────────────────────────────────────────────────────────────────

test("valid: board resolves with one job", async () => {
  assert.equal(await validateToken("gitlab", resolvesWith(1)), "valid");
});

test("valid: board resolves with many jobs", async () => {
  assert.equal(await validateToken("gitlab", resolvesWith(179)), "valid");
});

// ── Outcome: empty ──────────────────────────────────────────────────────────────────────

test("empty: board resolves with zero jobs", async () => {
  assert.equal(await validateToken("emptyco", resolvesWith(0)), "empty");
});

test("empty: 404 via a real GreenhouseFetchError is a drop, not an error", async () => {
  const err = new GreenhouseFetchError('no board "ghost"', "ghost", 404);
  assert.equal(await validateToken("ghost", rejectsWith(err)), "empty");
});

test("empty: 404 via a plain status-carrying object", async () => {
  assert.equal(await validateToken("ghost", rejectsWith({ status: 404 })), "empty");
});

// ── Outcome: error (transient / unexpected — skip this run, no retry) ───────────────────────

test("error: 500 from the board API", async () => {
  const err = new GreenhouseFetchError("server error", "flaky", 500);
  assert.equal(await validateToken("flaky", rejectsWith(err)), "error");
});

test("error: timeout-style error with no status", async () => {
  const err = new GreenhouseFetchError("timed out", "slowco");
  assert.equal(await validateToken("slowco", rejectsWith(err)), "error");
});

test("error: generic network Error", async () => {
  assert.equal(await validateToken("neterr", rejectsWith(new Error("ECONNRESET"))), "error");
});

test("error: non-Error thrown value (string) does not crash", async () => {
  assert.equal(await validateToken("weird", rejectsWith("boom")), "error");
});

test("error: thrown null does not crash the status read", async () => {
  // Guards the `?.status` optional-chain against a null/undefined rejection.
  assert.equal(await validateToken("weird", rejectsWith(null)), "error");
});

// ── Robustness: contract properties, not just outcomes ─────────────────────────────────────

test("forwards the exact token to the fetcher", async () => {
  let seen: string | undefined;
  const spy: BoardFetcher = async (token) => {
    seen = token;
    return [{ id: 1 }];
  };
  await validateToken("stripe", spy);
  assert.equal(seen, "stripe");
});

test("calls the fetcher exactly once — no retry on error (tier boundary)", async () => {
  let calls = 0;
  const spy: BoardFetcher = async () => {
    calls++;
    throw new GreenhouseFetchError("server error", "flaky", 500);
  };
  await validateToken("flaky", spy);
  assert.equal(calls, 1);
});

test("treats a status other than 404 (e.g. 403) as error, not drop", async () => {
  // Only 404 is the 'no such board' drop; every other status is a transient/unexpected error.
  const err = new GreenhouseFetchError("forbidden", "blocked", 403);
  assert.equal(await validateToken("blocked", rejectsWith(err)), "error");
});
