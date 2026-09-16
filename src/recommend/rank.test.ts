import { test } from "node:test";
import assert from "node:assert/strict";
import { matchedSkills, paginate, groupByRole } from "./rank.js";

test("groupByRole: same-role variants fold into one entry, best rank wins, locations collected", () => {
  const r = (id: number, company: string, title: string, location: string | null, score: number) => ({
    row: { company, title, location },
    id,
    score,
  });
  const grouped = groupByRole([
    r(1, "Stripe", "SWE, New Grad", "SF", 0.9),
    r(2, "Stripe", "SWE, New Grad", "London", 0.89),
    r(3, "DRW", "SWE Intern", "Chicago", 0.85),
    r(4, "Stripe", "SWE, New Grad ", "SF", 0.84), // trimmed-title twin, duplicate location
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].rep.id, 1); // best-ranked variant represents the role
  assert.equal(grouped[0].variantCount, 3);
  assert.deepEqual(grouped[0].locations, ["SF", "London"]); // deduped, rep first
  assert.equal(grouped[1].rep.id, 3);
});

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
