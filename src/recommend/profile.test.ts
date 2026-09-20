import { test } from "node:test";
import assert from "node:assert/strict";
import { softEditRequiresReembed, parseVectorText, buildTypedProfile } from "./profile.js";
import { defaultQuestionnaire } from "./questionnaire.js";

const PROFILE = { skills: ["typescript"], focus: "Built a job aggregator." };
const q = (over: object = {}) => ({ ...defaultQuestionnaire(), ...over });

// The re-embed rule is "re-embed iff canonical text changed" — deterministic, no field
// taxonomy to maintain. Soft fields (types/targetFields/interests) appear in the Seeking:
// section, so edits to them change the text; hard-only fields (grad years, work-auth,
// locations) never appear in it.

test("soft edit (interests) changes canonical text -> re-embed", () => {
  assert.equal(
    softEditRequiresReembed(PROFILE, q(), q({ interests: "prefer ML roles" })),
    true,
  );
});

test("soft edit (types, target fields) -> re-embed", () => {
  assert.equal(softEditRequiresReembed(PROFILE, q(), q({ types: ["internship"] })), true);
  assert.equal(
    softEditRequiresReembed(PROFILE, q(), q({ targetFields: [{ field: "swe", mustHave: false }] })),
    true,
  );
});

test("hard-only edits (grad years, work-auth, locations) -> NO re-embed", () => {
  assert.equal(
    softEditRequiresReembed(PROFILE, q(), q({ gradYearMin: 2027, gradYearMax: 2028 })),
    false,
  );
  assert.equal(softEditRequiresReembed(PROFILE, q(), q({ usCitizen: true })), false);
  assert.equal(softEditRequiresReembed(PROFILE, q(), q({ locStates: ["NY"] })), false);
});

test("mustHave toggle alone is hard-only: the field list (not the toggle) is what's embedded", () => {
  assert.equal(
    softEditRequiresReembed(
      PROFILE,
      q({ targetFields: [{ field: "swe", mustHave: false }] }),
      q({ targetFields: [{ field: "swe", mustHave: true }] }),
    ),
    false,
  );
});

test("parseVectorText: pgvector text form round-trips", () => {
  assert.deepEqual(parseVectorText("[1,-0.5,2e-3]"), [1, -0.5, 0.002]);
  assert.equal(parseVectorText(null), null);
  assert.equal(parseVectorText("junk"), null);
});

test('parseVectorText: "[]" is malformed (zero-dim vector), not [0]', () => {
  // "".split(",") is [""] and Number("") is 0 — without an explicit empty check the
  // "malformed -> null" contract silently produced a bogus 1-dim zero vector.
  assert.equal(parseVectorText("[]"), null);
  assert.equal(parseVectorText("[ ]"), null);
});

// Typed-profile mode (2026-09-17): the two fields map 1:1 onto the canonical sections —
// experience -> Experience: (focus), seeking -> Seeking: (questionnaire interests). No 14B
// extraction: the user typed the focus sentence directly, so skills are EMPTY (typed skill
// claims are unverifiable self-report; chips/overlap simply have nothing to show).
test("buildTypedProfile: maps experience->focus and seeking->interests, skills stay empty", () => {
  const out = buildTypedProfile("  Built a Fastify + Postgres job aggregator.  ", " quant or ML infra ");
  assert.ok(out);
  assert.equal(out.profile.focus, "Built a Fastify + Postgres job aggregator.");
  assert.deepEqual(out.profile.skills, []);
  assert.equal(out.questionnaire.interests, "quant or ML infra");
});

test("buildTypedProfile: seeking is optional; junk types are rejected or defaulted", () => {
  const out = buildTypedProfile("Built distributed crawlers in TypeScript.", undefined);
  assert.ok(out);
  assert.equal(out.questionnaire.interests, "");
  assert.equal(buildTypedProfile(42, "x"), null);
  assert.equal(buildTypedProfile("too short", "x"), null); // < 10 chars after trim
  assert.equal(buildTypedProfile("x".repeat(1001), "x"), null); // cap: focus is a sentence, not a resume
});
