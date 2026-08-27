import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGradDate, classYear } from "./grad-date.js";

// Pins Decision 17's class-year rule against the real posting that motivated it:
// "graduating between September 2027 and June 2028" must resolve to class of 2028 on BOTH
// ends — the old integer-year extraction stored 2027–2028, wrongly including Spring-2027 grads.

test("the motivating case: Sep 2027 – June 2028 is the class of 2028, not 2027–2028", () => {
  const min = parseGradDate("2027-09");
  const max = parseGradDate("2028-06");
  assert.ok(min && max);
  assert.equal(classYear(min), 2028);
  assert.equal(classYear(max), 2028);
});

test("Aug–Dec months roll forward; Jan–Jul keep their year", () => {
  assert.equal(classYear({ year: 2027, month: 8 }), 2028);
  assert.equal(classYear({ year: 2027, month: 12 }), 2028);
  assert.equal(classYear({ year: 2027, month: 1 }), 2027);
  assert.equal(classYear({ year: 2027, month: 7 }), 2027);
});

test("a bare year passes through unchanged — 'unspecified means Spring'", () => {
  const d = parseGradDate("2027");
  assert.deepEqual(d, { year: 2027, month: null });
  assert.equal(classYear(d!), 2027);
});

test("parses YYYY-MM and tolerates surrounding whitespace", () => {
  assert.deepEqual(parseGradDate(" 2028-05 "), { year: 2028, month: 5 });
});

test("rejects malformed input instead of guessing", () => {
  // Each of these is schema-valid as a string but semantically wrong — the guard nulls them
  // so a hallucinated value can't corrupt the grad-year filter (same stance as parseDate).
  for (const bad of ["2027-13", "2027-00", "27-05", "May 2027", "2027-5", "2027-05-01", ""]) {
    assert.equal(parseGradDate(bad), null, `should reject "${bad}"`);
  }
});
