import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeSkills } from "./aliases.js";

// The alias map runs before BOTH embedding and matched-skills explanations, so these tests
// pin the full normalization contract: lowercase, trim, alias, dedup, sort.

test("canonicalizeSkills: lowercases, aliases, dedups, sorts", () => {
  assert.deepEqual(
    canonicalizeSkills(["Postgres", "TS", "typescript", "  React.js ", "golang"]),
    ["go", "postgresql", "react", "typescript"],
  );
});

test("canonicalizeSkills: drops empties, keeps unknown skills verbatim (lowercased)", () => {
  assert.deepEqual(canonicalizeSkills(["", "  ", "Zig"]), ["zig"]);
});
