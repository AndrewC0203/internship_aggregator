import { createHash } from "node:crypto";
import { SIGNATURE_PROMPT_VERSION } from "./config.js";
import { canonicalizeSkills } from "./aliases.js";

// Canonical embed text + staleness fingerprint (Decision 31; spec "Role signature").
// Everything here is deterministic pure code: same inputs -> byte-identical text -> same
// vector for a given model. Template changes MUST bump TEMPLATE_VERSION in config.ts.

// Shared role-signature shape. Listing side: domains = [csField], level = opportunityType —
// deterministic copies of stored classification (Decision 16), the model is only trusted
// for skills + focus. Profile side: domains = target fields, level = target level(s).
export interface RoleSignature {
  skills: string[];
  domains: string[];
  level: string;
  focus: string;
}

const MAX_SKILLS = 20;
const MAX_FOCUS = 300;

// Boundary validation (same seam as classifier.ts): a signature that fails shape checks is
// a FAILED distillation — never saved, so the fingerprint stays stale and the row retries
// on the next enrichment pass.
export function validateSignature(raw: unknown): RoleSignature | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const strArr = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!strArr(o.skills) || o.skills.length === 0 || o.skills.length > MAX_SKILLS) return null;
  if (!strArr(o.domains)) return null;
  if (typeof o.level !== "string" || o.level.length === 0) return null;
  if (typeof o.focus !== "string" || o.focus.trim().length === 0 || o.focus.length > MAX_FOCUS)
    return null;
  return { skills: o.skills, domains: o.domains, level: o.level, focus: o.focus };
}

// Staleness key: prompt version + the EXACT prompt input tuple (spec "Schema"). Fingerprints
// are written only when a generated signature is successfully saved, which is what makes the
// enrichment pass resumable and crash-safe. JSON.stringify of a fixed-order array is
// order-stable, and null serializes distinctly from every string — null-safe comparison
// (IS DISTINCT FROM semantics) for free.
export interface FingerprintInput {
  title: string;
  company: string;
  descriptionPlain: string;
  opportunityType: string | null;
  csField: string | null;
}

export function signatureFingerprint(i: FingerprintInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        SIGNATURE_PROMPT_VERSION,
        i.title,
        i.company,
        i.descriptionPlain,
        i.opportunityType,
        i.csField,
      ]),
    )
    .digest("hex");
}

// Documented task prefixes are PART of the template (versioned by TEMPLATE_VERSION):
// nomic-embed-text wants search_document:/search_query: on the two sides; mxbai-embed-large
// prompts only the query side and takes documents raw. Matching on the model-name prefix
// keeps tag variants (":latest", quantizations) on the right template.
const docPrefix = (model: string): string =>
  model.startsWith("nomic") ? "search_document: " : "";
const queryPrefix = (model: string): string =>
  model.startsWith("nomic")
    ? "search_query: "
    : model.startsWith("mxbai")
      ? "Represent this sentence for searching relevant passages: "
      : "";

// Listing side: sectioned so requirements read as requirements — "Requires:" keeps a
// posting's skill list from blurring into what a candidate HAS.
export function listingCanonicalText(sig: RoleSignature, model: string): string {
  const skills = canonicalizeSkills(sig.skills).join(", ");
  return (
    `${docPrefix(model)}Role: ${sig.level} ${sig.domains.join(", ")} — ${sig.focus.trim()}` +
    `\nRequires: ${skills}`
  );
}

// Profile side. Experience = resume-evidenced only (approved profile); Seeking = the
// questionnaire's wants (target levels, target fields, free-text interests — the soft
// answers merge HERE, one mechanism, no weight knobs). The sections keep "has" and "wants"
// from blurring: an ML interest must not read as ML experience.
//
// The skills LIST is deliberately NOT embedded (user decision 2026-09-14, TEMPLATE_VERSION
// 2): in a single-vector design, weight IS token share, and resume skill lists are the
// noisiest part of a profile (routinely padded), so they get ~zero ranking weight by
// omission — the focus sentence (actual demonstrated work) carries the Experience signal.
// Screened against the labeled eval set before shipping: P@10 identical with and without
// the skills sentence (0.60 strict / 0.90 lenient, judged projection), soft-preference
// responsiveness intact. Skills still drive the matched-skills explanations and the
// overlap scorer — they inform, they just don't pull the vector.
export interface ProfileJson {
  skills: string[];
  focus: string;
}

export interface QuestionnaireSoft {
  types: string[];
  targetFields: Array<{ field: string; mustHave: boolean }>;
  interests: string;
}

export function profileCanonicalText(
  p: ProfileJson,
  q: QuestionnaireSoft,
  model: string,
): string {
  const fields = q.targetFields.map((f) => f.field).join(", ");
  const seek = [
    q.types.length ? `${q.types.join(", ")} roles` : "early-career roles",
    fields ? `in ${fields}` : "",
    q.interests.trim() ? `— ${q.interests.trim()}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${queryPrefix(model)}Experience: ${p.focus.trim()}\nSeeking: ${seek}`;
}

// Baseline (b) for the eval gate: the honest no-distillation text — full description, not
// just title/company/csField. Truncation documented: first 6000 chars, the same cap the
// classify/extract prompts use (classifier.ts MAX_DESC_CHARS).
export const BASELINE_DESC_CAP = 6000;

export function baselineCanonicalText(
  title: string,
  descriptionPlain: string,
  model: string,
): string {
  return `${docPrefix(model)}${title}\n${descriptionPlain.slice(0, BASELINE_DESC_CAP)}`;
}
