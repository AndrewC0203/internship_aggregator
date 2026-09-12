import { test } from "node:test";
import assert from "node:assert/strict";
import { groundClaims, profileModel } from "./profile-extract.js";

// The quote-grounding boundary (Decision 24 pattern applied to resumes): the model may only
// claim what it can point to. groundClaims is the pure enforcement seam.

const RESUME = `Andrew Choi
Built a job aggregator in TypeScript with PostgreSQL and Fastify.
Coursework: data structures, machine   learning.`;

test("groundClaims: keeps claims whose evidence appears in the resume (case/whitespace-insensitive)", () => {
  const out = groundClaims(
    {
      skills: [
        { name: "TypeScript", evidence: "job aggregator in TypeScript" },
        { name: "postgresql", evidence: "with PostgreSQL and Fastify" },
        // whitespace-normalized match: resume has "machine   learning"
        { name: "machine learning", evidence: "machine learning" },
      ],
      focus: { text: "Builds backend services.", evidence: "Built a job aggregator" },
    },
    RESUME,
  );
  assert.deepEqual(out.skills, ["machine learning", "postgresql", "typescript"]);
  assert.equal(out.focus, "Builds backend services.");
  assert.deepEqual(out.dropped, []);
});

test("groundClaims: drops fabricated-evidence claims and lists them", () => {
  const out = groundClaims(
    {
      skills: [
        { name: "typescript", evidence: "job aggregator in TypeScript" },
        { name: "kubernetes", evidence: "deployed on Kubernetes" }, // not in resume
      ],
      focus: { text: "f", evidence: "Built a job aggregator" },
    },
    RESUME,
  );
  assert.deepEqual(out.skills, ["typescript"]);
  assert.deepEqual(out.dropped, ["kubernetes"]);
});

test("groundClaims: unverifiable focus evidence throws — a profile without grounded focus is not publishable", () => {
  assert.throws(
    () =>
      groundClaims(
        {
          skills: [{ name: "typescript", evidence: "job aggregator in TypeScript" }],
          focus: { text: "f", evidence: "ten years at Google" },
        },
        RESUME,
      ),
    /focus/,
  );
});

test("profileModel: per-pass env > global > 14b default", () => {
  assert.equal(profileModel({}), "qwen2.5:14b-instruct");
  assert.equal(profileModel({ OLLAMA_MODEL: "x" }), "x");
  assert.equal(profileModel({ OLLAMA_MODEL: "x", OLLAMA_PROFILE_MODEL: "y" }), "y");
});
