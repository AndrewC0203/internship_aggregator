import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateGate } from "./rate-limit.js";

// The gate enforces a minimum interval between successive requests to one host
// (Decision 27: fixed per-host delay). Clock and sleep are injectable so tests run
// instantly and assert the exact delays requested.

function fakeTimers(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms; // sleeping advances the fake clock
      return Promise.resolve();
    },
    slept,
  };
}

test("first call passes immediately", async () => {
  const { now, sleep, slept } = fakeTimers();
  const gate = createRateGate(500, { sleepFn: sleep, nowFn: now });

  await gate.wait();

  assert.deepEqual(slept, []);
});

test("a second call inside the interval waits out the remainder", async () => {
  const { now, sleep, slept } = fakeTimers();
  const gate = createRateGate(500, { sleepFn: sleep, nowFn: now });

  await gate.wait(); // t=0, next slot at 500
  await gate.wait(); // still t=0 -> must sleep 500

  assert.deepEqual(slept, [500]);
});

test("calls spaced wider than the interval never sleep", async () => {
  const timers = fakeTimers();
  const gate = createRateGate(500, { sleepFn: timers.sleep, nowFn: timers.now });

  await gate.wait();
  // Simulate 600ms of real work (fetch + normalize) before the next request.
  await timers.sleep(600);
  timers.slept.length = 0;

  await gate.wait();

  assert.deepEqual(timers.slept, []);
});

test("back-to-back calls space out at exactly one interval each", async () => {
  const { now, sleep, slept } = fakeTimers();
  const gate = createRateGate(500, { sleepFn: sleep, nowFn: now });

  await gate.wait();
  await gate.wait();
  await gate.wait();
  await gate.wait();

  assert.deepEqual(slept, [500, 500, 500]);
});

test("a zero interval disables pacing entirely", async () => {
  const { now, sleep, slept } = fakeTimers();
  const gate = createRateGate(0, { sleepFn: sleep, nowFn: now });

  await gate.wait();
  await gate.wait();

  assert.deepEqual(slept, []);
});
