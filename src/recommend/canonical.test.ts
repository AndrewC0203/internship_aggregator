import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSignature,
  signatureFingerprint,
  listingCanonicalText,
  profileCanonicalText,
  baselineCanonicalText,
} from "./canonical.js";

const SIG = {
  skills: ["python", "pytorch"],
  domains: ["ml_ai"],
  level: "internship",
  focus: "Trains and evaluates ML models for ranking.",
};

test("listing canonical text is deterministic and sectioned (nomic prefixes)", () => {
  // Template v3 (Decision 35, gate 2026-09-17): the LITERAL title line leads — under v2 a
  // title term the 7B dropped from focus ("Site Reliability", "Core Operations") was
  // invisible to the vector; the gate's one strict-P@10 swap was exactly that mechanism.
  const a = listingCanonicalText("  SWE Intern ", SIG, "nomic-embed-text");
  // Byte-identical on repeat calls — determinism is the invariant embeddings depend on:
  // the same signature must always produce the same vector for a given model+template.
  assert.equal(a, listingCanonicalText("  SWE Intern ", { ...SIG }, "nomic-embed-text"));
  assert.equal(
    a,
    "search_document: Title: SWE Intern\n" +
      "Role: internship ml_ai — Trains and evaluates ML models for ranking.\n" +
      "Requires: python, pytorch",
  );
});

test("mxbai: document side has NO prefix; query side has the documented prompt", () => {
  assert.ok(!listingCanonicalText("T", SIG, "mxbai-embed-large").startsWith("search_document:"));
  const q = profileCanonicalText(
    { skills: ["python"], focus: "Built data pipelines." },
    { types: ["internship"], targetFields: [{ field: "swe", mustHave: false }], interests: "" },
    "mxbai-embed-large",
  );
  assert.ok(q.startsWith("Represent this sentence for searching relevant passages: "));
});

test("profile text keeps Experience (has) and Seeking (wants) in separate sections", () => {
  const t = profileCanonicalText(
    { skills: ["java"], focus: "Backend services in Java." },
    {
      types: ["internship"],
      targetFields: [{ field: "ml_ai", mustHave: false }],
      interests: "interested in ML",
    },
    "nomic-embed-text",
  );
  const [expLine, seekLine] = t.replace("search_query: ", "").split("\n");
  // An ML *interest* must never read as ML *experience* — the sections are the mechanism.
  assert.ok(expLine.startsWith("Experience:") && !expLine.includes("ML"));
  assert.ok(seekLine.startsWith("Seeking:"));
  assert.ok(seekLine.includes("ml_ai") && seekLine.includes("interested in ML"));
});

test("profile text does NOT embed the skills list (TEMPLATE_VERSION 2: weight = token share)", () => {
  const t = profileCanonicalText(
    { skills: ["java", "kubernetes"], focus: "Backend services." },
    { types: [], targetFields: [], interests: "" },
    "nomic-embed-text",
  );
  // Skills inform (matched-skills chips, overlap scorer) but never pull the vector —
  // padded resume skill lists must not outweigh demonstrated experience.
  assert.ok(!t.includes("kubernetes") && !t.includes("Skills:"));
});

test("baseline text: title + truncated description, documented cap", () => {
  const t = baselineCanonicalText("SWE Intern", "x".repeat(7000), "nomic-embed-text");
  assert.ok(t.startsWith("search_document: SWE Intern\n"));
  assert.ok(t.length <= "search_document: SWE Intern\n".length + 6000);
});

test("fingerprint staleness matrix: each input flips it independently; null-safe", () => {
  const base = {
    title: "t",
    company: "c",
    descriptionPlain: "d",
    opportunityType: "internship" as string | null,
    csField: "swe" as string | null,
  };
  const fp = signatureFingerprint(base);
  assert.equal(fp, signatureFingerprint({ ...base })); // stable across calls
  for (const change of [
    { title: "t2" },
    { company: "c2" },
    { descriptionPlain: "d2" },
    { opportunityType: null },
    { csField: null },
    { csField: "ml_ai" },
  ]) {
    assert.notEqual(signatureFingerprint({ ...base, ...change }), fp, JSON.stringify(change));
  }
  // null vs null compares equal — IS NOT DISTINCT FROM semantics, no NULL != NULL trap.
  assert.equal(
    signatureFingerprint({ ...base, csField: null }),
    signatureFingerprint({ ...base, csField: null }),
  );
});

test("validateSignature: accepts the shape, rejects junk", () => {
  assert.deepEqual(validateSignature(SIG), SIG);
  assert.equal(validateSignature(null), null);
  assert.equal(validateSignature({ ...SIG, skills: "python" }), null);
  assert.equal(validateSignature({ ...SIG, skills: [] }), null);
  assert.equal(validateSignature({ ...SIG, focus: "" }), null);
  assert.equal(validateSignature({ ...SIG, focus: "x".repeat(301) }), null);
  assert.equal(validateSignature({ ...SIG, skills: Array(25).fill("x") }), null); // cap 20
});

