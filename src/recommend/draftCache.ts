import { createHash } from "node:crypto";
import type { ProfileJson } from "./canonical.js";

// In-process cache for /search's "paste and go" draft (single-user app, one slot). Kept
// OUT of user_profile on purpose: /profile's resumeText/extractedProfile columns already
// mean "the human's in-progress draft on the /profile page" — reusing them here would mean
// a quick paste into /search's box silently overwrites what /profile shows, and a stale
// draft would haunt every future /search visit until you remembered to clear it. Living in
// memory instead means: no schema change, no re-embed cost on every subsequent request
// (fingerprint-gated), and a server restart is the natural "clear" — acceptable for a
// deliberately ephemeral, not-yet-approved thing.

export interface Draft {
  fingerprint: string;
  profile: ProfileJson;
  vector: number[];
  embeddingModel: string;
  templateVersion: number;
}

let current: Draft | null = null;
// Ordering guard: setDraft happens AFTER an awaited extract+embed round-trip, so two
// overlapping pastes can complete in the opposite order they were submitted (e.g. the
// first hits a model retry, the second sails through). Sequence tokens — issued at
// request START via beginDraft() — make "the paste the user did last" win, not "the
// paste whose model call finished last". clearDraft bumps past every issued token so a
// save/clear also invalidates any still-in-flight older paste.
let seqCounter = 0;
let acceptedSeq = 0;

export function draftFingerprint(resumeText: string): string {
  return createHash("sha256").update(resumeText).digest("hex");
}

export function beginDraft(): number {
  return ++seqCounter;
}

export function getDraft(): Draft | null {
  return current;
}

export function setDraft(draft: Draft, seq: number): void {
  if (seq <= acceptedSeq) return; // an action newer than this paste already happened
  current = draft;
  acceptedSeq = seq;
}

export function clearDraft(): void {
  current = null;
  acceptedSeq = ++seqCounter;
}
