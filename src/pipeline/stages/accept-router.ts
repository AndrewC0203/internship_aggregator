import type { OpportunityType, CsField } from "@prisma/client";

// Cheap regex accept-router (Decision 12, option B2). It fast-tracks ONLY unambiguous CS
// internships / co-ops so they skip the AI classify call. Everything it doesn't accept falls
// through to the model — so it is deliberately high-precision and false-negative-heavy.
//
// KEY INVARIANT (Decision 12 / Decision 10): a match REQUIRES a CS signal AND an intern/co-op
// signal in the TITLE together. Never accept on the intern token alone — "Marketing Intern"
// has the intern token but no CS signal, and accepting it would write a non-CS role, breaking
// the CS-relevance hard filter.

// CS signal — specific technical tokens only. Intentionally omits tokens that match non-CS
// roles: bare "engineer" (sales / mechanical / civil engineer), "quant" (matches "quantity"),
// and bare "security" (matches physical-security / "Security Officer" roles — we keep only
// "cyber", which is unambiguous, and let security-engineering titles fall through to the AI).
// "developer" is the one slightly looser token kept in — tighten to "software developer" if
// you ever see a false accept (e.g. a rare "Business Developer").
const CS_SIGNAL =
  /(software|\bswe\b|developer|data scien|data engineer|machine learning|\bml\b|computer scien|back[- ]?end|front[- ]?end|full[- ]?stack|dev ?ops|site reliability|\bsre\b|cyber|firmware|embedded|hardware|\bandroid\b|\bios\b|platform engineer|infrastructure engineer)/i;

const INTERN_SIGNAL = /\b(intern|internship|co-?op)\b/i;
const COOP_SIGNAL = /\bco-?op\b/i;

// Returns the opportunity type to fast-track this title as, or null to defer it to the AI.
export function acceptRoute(title: string): OpportunityType | null {
  if (!CS_SIGNAL.test(title) || !INTERN_SIGNAL.test(title)) return null;
  return COOP_SIGNAL.test(title) ? "co_op" : "internship";
}

// CS subfield from the TITLE, for router-accepted listings only (Decision 16). These skip the
// model entirely, so without this the highest-confidence listings would be the only ones with
// a null csField. Same token vocabulary as CS_SIGNAL, so anything the router can accept has a
// decent shot at mapping; FIRST match wins, so specific fields are checked before the broad
// swe catch-all (e.g. "Machine Learning Software Engineer Intern" -> ml_ai, its lead token).
// No mappable token -> null, NOT "other": "other" is the model's confident "CS but none of
// the buckets", while null is honest "regex couldn't tell" — conflating them would make
// "other" unqueryable.
const FIELD_RULES: Array<[RegExp, CsField]> = [
  [/machine learning|\bml\b|\bai\b|artificial intelligence|deep learning/i, "ml_ai"],
  [/data scien|data engineer|data analy|analytics/i, "data"],
  [/quantitative|\bquant\b/i, "quant"],
  [/cyber|security/i, "security"],
  [/firmware|embedded|hardware|\bfpga\b|\basic\b|silicon/i, "hardware_embedded"],
  [/dev ?ops|site reliability|\bsre\b|infrastructure|platform engineer|cloud engineer/i, "devops_infra"],
  [/product manage|program manage|technical product/i, "product"],
  [
    /software|\bswe\b|developer|back[- ]?end|front[- ]?end|full[- ]?stack|\bandroid\b|\bios\b|mobile engineer|web engineer/i,
    "swe",
  ],
];

export function csFieldFromTitle(title: string): CsField | null {
  for (const [re, field] of FIELD_RULES) {
    if (re.test(title)) return field;
  }
  return null;
}
