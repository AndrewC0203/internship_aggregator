import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultQuestionnaire,
  parseQuestionnaire,
  workAuthExclusions,
  hardConditions,
} from "./questionnaire.js";

const q = (over: object) => ({ ...defaultQuestionnaire(), ...over });

// ── Work-auth mapping (spec table: three separate booleans, never one conflated status) ──

test("work-auth: citizen sees everything", () => {
  assert.deepEqual(workAuthExclusions(q({ usCitizen: true, needsSponsorship: false })), {
    excludeCitizenRequired: false,
    excludeNoSponsorship: false,
  });
});

test("work-auth: non-citizen excludes us_citizen_required", () => {
  assert.equal(workAuthExclusions(q({ usCitizen: false })).excludeCitizenRequired, true);
});

test("work-auth: OPT case — authorized NOW but needs sponsorship LATER still excludes no_sponsorship", () => {
  const e = workAuthExclusions(
    q({ usCitizen: false, workAuthorized: true, needsSponsorship: true }),
  );
  assert.equal(e.excludeNoSponsorship, true);
});

test("work-auth: unanswered (nulls) excludes NOTHING — filters act only on explicit contradictions", () => {
  assert.deepEqual(workAuthExclusions(q({})), {
    excludeCitizenRequired: false,
    excludeNoSponsorship: false,
  });
});

// ── Hard-filter conditions (each answered facet contributes exactly one condition) ──────

test("hardConditions: empty questionnaire -> no conditions (browse-everything default)", () => {
  assert.equal(hardConditions(q({})).length, 0);
});

test("hardConditions: each answered facet contributes exactly one condition", () => {
  assert.equal(hardConditions(q({ gradYearMin: 2027, gradYearMax: 2028 })).length, 1);
  assert.equal(hardConditions(q({ types: ["internship"] })).length, 1);
  assert.equal(hardConditions(q({ targetFields: [{ field: "swe", mustHave: true }] })).length, 1);
  assert.equal(hardConditions(q({ locStates: ["NY"] })).length, 1);
  assert.equal(hardConditions(q({ usCitizen: false })).length, 1);
});

test("hardConditions: non-must-have target fields are soft — no condition", () => {
  assert.equal(hardConditions(q({ targetFields: [{ field: "swe", mustHave: false }] })).length, 0);
});

// ── Boundary parsing (querystring/JSON junk never reaches SQL) ───────────────────────────

test("parseQuestionnaire: junk dropped, unknown enum values dropped, states uppercased", () => {
  const p = parseQuestionnaire({
    types: ["internship", "ceo"],
    locStates: ["ny"],
    gradYearMin: "x",
    targetFields: [{ field: "swe", mustHave: "yes" }, { field: "not_a_field", mustHave: true }],
    interests: 42,
  });
  assert.deepEqual(p.types, ["internship"]);
  assert.deepEqual(p.locStates, ["NY"]);
  assert.equal(p.gradYearMin, null);
  // Junk mustHave degrades to SOFT (false), never to hard: a malformed value must not
  // silently promote a field into an exclusion filter — wrong direction to fail in.
  assert.deepEqual(p.targetFields, [{ field: "swe", mustHave: false }]);
  assert.equal(p.interests, "");
});

test("parseQuestionnaire: null/undefined input -> defaults", () => {
  assert.deepEqual(parseQuestionnaire(null), defaultQuestionnaire());
  assert.deepEqual(parseQuestionnaire(undefined), defaultQuestionnaire());
});
