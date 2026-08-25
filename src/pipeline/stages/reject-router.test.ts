import { test } from "node:test";
import assert from "node:assert/strict";
import { rejectRoute } from "./reject-router.js";
import { acceptRoute } from "./accept-router.js";

// The reject-router is the higher-stakes of the two routers (Decision 13). The accept-router
// fails by wasting a model call; this one fails by making a listing never appear. So the
// tests below are weighted toward proving it does NOT reject things — the false-reject
// direction — rather than proving it rejects enough.

// --- 1. The early-career veto: the regression tests that matter most ---

// This exact title is why the veto exists. It is a real posting from the 2,008-title sample
// (research/local-model-performance.md), and a plausible first-draft seniority regex killed
// it on the token "manager" — even though CLASSIFY_SYSTEM says to keep it (a technical
// product role IS cs_relevant, and new_grad is a valid opportunity_type).
test("does NOT reject a new-grad role that also carries a seniority token — the key invariant", () => {
  assert.equal(rejectRoute("Associate Product Manager, New Grad (2027 Start)"), false);
});

test("does NOT reject an internship that also carries a non-CS function token", () => {
  // "Marketing Intern" is genuinely out of scope, but that call belongs to the MODEL, not to
  // a regex — the accept-router already refuses to fast-track it, so the model decides.
  assert.equal(rejectRoute("Marketing Intern"), false);
});

test("veto beats seniority on a research/staff-flavoured early-career title", () => {
  assert.equal(rejectRoute("PhD GenAI Research Scientist Intern"), false);
});

test("veto covers co-op spellings", () => {
  assert.equal(rejectRoute("Senior Data Co-op"), false);
  assert.equal(rejectRoute("Engineering Coop Program"), false);
});

test("veto covers university / campus / apprentice / entry-level phrasing", () => {
  assert.equal(rejectRoute("University Recruiting Program - Software"), false);
  assert.equal(rejectRoute("Campus Hire, Engineering Manager Track"), false);
  assert.equal(rejectRoute("Software Apprentice"), false);
  assert.equal(rejectRoute("Entry-Level Operations Associate"), false);
});

// --- 2. "fellow" is a veto token, not a seniority token ---

// "Distinguished Fellow" IS a senior title, but fellowship is one of our opportunity types.
// Resolving that ambiguity is the model's job, so the router must defer rather than drop.
test("does NOT reject 'Distinguished Fellow' — fellowship is an opportunity type", () => {
  assert.equal(rejectRoute("Distinguished Fellow"), false);
});

test("does NOT reject a research fellowship", () => {
  assert.equal(rejectRoute("Machine Learning Research Fellowship"), false);
});

// --- 3. Obvious drops (no early-career signal anywhere in the title) ---

test("rejects an experienced engineering role on the seniority token", () => {
  assert.equal(rejectRoute("Senior Software Engineer"), true);
});

test("rejects a non-CS function role", () => {
  assert.equal(rejectRoute("Account Executive"), true);
});

test("rejects a role that is both non-CS and senior", () => {
  assert.equal(rejectRoute("Enterprise Sales Manager"), true);
});

test("rejects other common seniority markers", () => {
  assert.equal(rejectRoute("Staff Software Engineer - AI Research Infrastructure"), true);
  assert.equal(rejectRoute("Principal Research Scientist"), true);
  assert.equal(rejectRoute("Director of Engineering"), true);
  assert.equal(rejectRoute("VP, Data Platform"), true);
  assert.equal(rejectRoute("Head of Infrastructure"), true);
});

test("rejects other common non-CS functions", () => {
  assert.equal(rejectRoute("Payroll Specialist"), true);
  assert.equal(rejectRoute("Paralegal"), true);
  assert.equal(rejectRoute("Executive Assistant"), true);
  assert.equal(rejectRoute("Registered Nurse"), true);
});

// --- 4. Ambiguous titles must fall through to the model (deliberate non-rejects) ---

// These are the tokens deliberately OMITTED from the reject regexes. Each is a CS-adjacent
// role that a broader regex would have eaten, so "false" here is a designed outcome, not an
// accident — if someone later widens the regexes, these tests should fail loudly.
test("defers ambiguous analyst titles to the model ('analyst' is not a reject token)", () => {
  assert.equal(rejectRoute("Data Analyst"), false);
  assert.equal(rejectRoute("Security Analyst"), false);
});

test("defers ambiguous engineering titles to the model", () => {
  assert.equal(rejectRoute("Field Engineer"), false);
  assert.equal(rejectRoute("Software Engineer"), false);
});

test("defers 'design' titles to the model — design can be technical", () => {
  assert.equal(rejectRoute("Design Engineer"), false);
  assert.equal(rejectRoute("Chip Design Verification"), false);
});

test("defers 'support' titles to the model — support can be technical", () => {
  assert.equal(rejectRoute("Technical Support Engineer"), false);
});

test("defers level-suffixed titles to the model (II/III/IV are not seniority tokens)", () => {
  // Deliberately not rejected: roman-numeral levels read as senior to a human but mis-match
  // too easily, and a wrong reject costs more than an extra model call.
  assert.equal(rejectRoute("Software Engineer II"), false);
  assert.equal(rejectRoute("Software Engineer III"), false);
});

// --- 5. Case insensitivity ---

test("is case-insensitive on rejects", () => {
  assert.equal(rejectRoute("SENIOR SOFTWARE ENGINEER"), true);
  assert.equal(rejectRoute("account executive"), true);
});

test("is case-insensitive on the veto", () => {
  assert.equal(rejectRoute("SENIOR SOFTWARE ENGINEER INTERN"), false);
  assert.equal(rejectRoute("associate product manager, new grad"), false);
});

// --- 6. Property: the two routers can never both fire on the same title ---

// Structural reason this holds: acceptRoute() requires an intern/co-op token in the title,
// and every such token is also in the reject-router's early-career veto — so anything the
// accept-router accepts is vetoed out of rejection. If someone adds a token to one router
// without the other, this test is the tripwire.
const ROUTER_CORPUS = [
  "Software Engineering Intern",
  "Data Science Co-op",
  "Backend Developer Internship",
  "Cybersecurity Intern",
  "Marketing Intern",
  "Senior Software Engineer",
  "Account Executive",
  "Associate Product Manager, New Grad (2027 Start)",
  "Distinguished Fellow",
  "Data Analyst",
  "Field Engineer",
  "Enterprise Sales Manager",
  "Software Engineer II",
  "Machine Learning Research Fellowship",
  "Director of Engineering",
  "Summer 2026 Analyst Program",
  "Embedded Firmware Engineering Intern",
  "Technical Support Engineer",
];

test("no title is both accepted and rejected", () => {
  for (const title of ROUTER_CORPUS) {
    const accepted = acceptRoute(title) !== null;
    const rejected = rejectRoute(title);
    assert.ok(
      !(accepted && rejected),
      `"${title}" was both accepted (${acceptRoute(title)}) and rejected — the routers disagree`,
    );
  }
});

test("every accept-router acceptance is vetoed by the reject-router", () => {
  // The stronger form of the property above: not just "not both", but specifically that the
  // veto — not luck — is what keeps them disjoint.
  for (const title of ROUTER_CORPUS) {
    if (acceptRoute(title) !== null) {
      assert.equal(rejectRoute(title), false, `"${title}" is accepted but not vetoed`);
    }
  }
});
