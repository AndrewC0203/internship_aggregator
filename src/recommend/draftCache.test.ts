import { test } from "node:test";
import assert from "node:assert/strict";
import { beginDraft, setDraft, getDraft, clearDraft } from "./draftCache.js";

const draft = (fingerprint: string) => ({
  fingerprint,
  profile: { skills: ["ts"], focus: "x" },
  vector: [0],
  embeddingModel: "m",
  templateVersion: 1,
});

// The slot is written after an awaited model round-trip, so wall-clock completion order can
// invert submission order. Sequence tokens make "the paste the user did LAST" win, not "the
// paste whose Ollama call happened to finish last".
test("a paste that started earlier can't clobber one that started later", () => {
  const a = beginDraft();
  const b = beginDraft();
  setDraft(draft("B"), b); // later paste, faster model call — lands first
  setDraft(draft("A"), a); // earlier paste resolves late — must be discarded
  assert.equal(getDraft()?.fingerprint, "B");
});

test("clearDraft invalidates in-flight pastes begun before the clear", () => {
  const a = beginDraft();
  clearDraft(); // e.g. save/clear clicked while an old paste is still extracting
  setDraft(draft("A"), a);
  assert.equal(getDraft(), null);
});
