import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSignature, distillModel } from "./signature.js";

// Pure parts of the distillation stage (the model call itself is never unit-tested — repo
// rule). assembleSignature is the boundary where model output crosses into our data model.

const IN = {
  title: "ML Intern",
  company: "Acme",
  descriptionPlain: "d",
  opportunityType: "internship" as string | null,
  csField: "ml_ai" as string | null,
};

test("assembleSignature: domains/level are deterministic copies, skills canonicalized", () => {
  const sig = assembleSignature({ skills: ["PyTorch", "Postgres"], focus: "Trains models." }, IN);
  assert.deepEqual(sig, {
    skills: ["postgresql", "pytorch"],
    domains: ["ml_ai"],
    level: "internship",
    focus: "Trains models.",
  });
});

test("assembleSignature: null csField -> empty domains; null type -> 'unknown' level", () => {
  const sig = assembleSignature(
    { skills: ["go"], focus: "f" },
    { ...IN, opportunityType: null, csField: null },
  );
  assert.deepEqual(sig?.domains, []);
  assert.equal(sig?.level, "unknown");
});

test("assembleSignature: junk model output -> null (empty skills / empty focus)", () => {
  assert.equal(assembleSignature({ skills: [], focus: "f" }, IN), null);
  assert.equal(assembleSignature({ skills: ["go"], focus: "" }, IN), null);
  assert.equal(assembleSignature({ skills: ["  ", ""], focus: "f" }, IN), null);
});

test("distillModel: per-pass env > global > 7b default (passModel precedence)", () => {
  assert.equal(distillModel({}), "qwen2.5:7b-instruct");
  assert.equal(distillModel({ OLLAMA_MODEL: "x" }), "x");
  assert.equal(distillModel({ OLLAMA_MODEL: "x", OLLAMA_DISTILL_MODEL: "y" }), "y");
});
