import { test } from "node:test";
import assert from "node:assert/strict";
import { matchedSkills, paginate } from "./rank.js";

test("matchedSkills: canonical intersection, demonstrated skills only", () => {
  // Both sides are already canonicalized (alias map applied at write time on both paths),
  // so the intersection is a plain set operation — and the output is what the UI renders.
  assert.deepEqual(
    matchedSkills(["postgresql", "python", "typescript"], { skills: ["python", "react", "postgresql"] }),
    ["postgresql", "python"],
  );
  assert.deepEqual(matchedSkills(["go"], { skills: [] }), []);
  assert.deepEqual(matchedSkills(["go"], null), []);
});

test("paginate: 1-based pages, clamped, stable slices", () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  assert.deepEqual(paginate(rows, 1, 10), rows.slice(0, 10));
  assert.deepEqual(paginate(rows, 3, 10), rows.slice(20, 25));
  assert.deepEqual(paginate(rows, 99, 10), []); // past the end -> empty, not an error
  assert.deepEqual(paginate(rows, 0, 10), rows.slice(0, 10)); // page<1 clamps to 1
});
