import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptRoute } from "./accept-router.js";

// The accept-router is a pure, high-stakes function (a false accept writes a non-CS role
// past the CS filter — Decision 12 / Decision 10), so its precision is worth pinning down.

// --- accepts (CS token AND intern/co-op token together) ---

test("accepts an obvious CS internship as internship", () => {
  assert.equal(acceptRoute("Software Engineering Intern"), "internship");
});

test("accepts a CS co-op as co_op", () => {
  assert.equal(acceptRoute("Data Science Co-op"), "co_op");
});

test("accepts on the 'internship' word, not just 'intern'", () => {
  assert.equal(acceptRoute("Backend Developer Internship"), "internship");
});

test("accepts cybersecurity via the 'cyber' token", () => {
  assert.equal(acceptRoute("Cybersecurity Intern"), "internship");
});

test("is case-insensitive", () => {
  assert.equal(acceptRoute("software engineer intern"), "internship");
});

// --- rejects (defer to the AI) ---

test("rejects a non-CS internship (no CS token) — the key invariant", () => {
  assert.equal(acceptRoute("Marketing Intern"), null);
});

test("rejects a CS role with no intern/co-op token", () => {
  assert.equal(acceptRoute("Senior Software Engineer"), null);
});

test("rejects physical-security roles (bare 'security' is not a CS token)", () => {
  assert.equal(acceptRoute("Security Officer Intern"), null);
});

test("defers non-obvious early-career titles to the AI (accepted false negative)", () => {
  assert.equal(acceptRoute("Summer 2026 Analyst Program"), null);
});
