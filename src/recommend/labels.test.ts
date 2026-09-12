import { test } from "node:test";
import assert from "node:assert/strict";
import { alignmentChip, selectivityBadge, SELECTIVITY_BADGE_TEXT } from "./labels.js";
import { defaultQuestionnaire } from "./questionnaire.js";

const q = (over: object = {}) => ({ ...defaultQuestionnaire(), ...over });

// Chip inputs mirror the listing row fields the checks read.
const listing = (over: object = {}) => ({
  descriptionPlain: "",
  gradYearMin: null as number | null,
  gradYearMax: null as number | null,
  citizenshipStatus: null as string | null,
  degreeStatus: null as string | null,
  ...over,
});

// ── Alignment chip (Decision 32: facts shown, never "meets requirements") ───────────────

test("chip: nothing checkable -> unverified", () => {
  const c = alignmentChip(listing(), q());
  assert.equal(c.state, "unverified");
  assert.deepEqual(c.facts, []);
});

test("chip: stated YOE > 0 is a gap, with the fact shown", () => {
  const c = alignmentChip(listing({ descriptionPlain: "Requires 3+ years of experience." }), q());
  assert.equal(c.state, "gaps");
  assert.ok(c.facts.some((f) => f.includes("3+ years")));
});

test("chip: YOE 0 / unstated is NOT a gap", () => {
  const zero = alignmentChip(
    listing({ descriptionPlain: "0-2 years of experience welcome.", degreeStatus: "pursuing" }),
    q(),
  );
  assert.equal(zero.state, "clear");
});

test("chip: user grad window entirely outside listing window is a gap (both sides stated)", () => {
  const c = alignmentChip(
    listing({ gradYearMin: 2026, gradYearMax: 2026 }),
    q({ gradYearMin: 2028, gradYearMax: 2029 }),
  );
  assert.equal(c.state, "gaps");
  // Overlap or unstated user window -> checkable, no gap.
  assert.equal(
    alignmentChip(listing({ gradYearMin: 2026, gradYearMax: 2029 }), q({ gradYearMin: 2028, gradYearMax: 2029 })).state,
    "clear",
  );
});

test("chip: completed_required degree is a gap; pursuing is clear", () => {
  assert.equal(alignmentChip(listing({ degreeStatus: "completed_required" }), q()).state, "gaps");
  assert.equal(alignmentChip(listing({ degreeStatus: "pursuing" }), q()).state, "clear");
});

test("chip: work-auth contradiction is a gap even though ranking usually filters it", () => {
  const c = alignmentChip(
    listing({ citizenshipStatus: "us_citizen_required" }),
    q({ usCitizen: false }),
  );
  assert.equal(c.state, "gaps");
  const opt = alignmentChip(
    listing({ citizenshipStatus: "no_sponsorship" }),
    q({ needsSponsorship: true }),
  );
  assert.equal(opt.state, "gaps");
});

// ── Selectivity badge (curated list; unlisted = NOT ASSESSED, never "less selective") ───

test("badge: curated company gets the fixed wording; unlisted gets null", () => {
  assert.equal(selectivityBadge("Jane Street"), SELECTIVITY_BADGE_TEXT);
  assert.equal(selectivityBadge("  google "), SELECTIVITY_BADGE_TEXT); // case/space-insensitive
  assert.equal(selectivityBadge("Some Startup Nobody Ranked"), null);
});
