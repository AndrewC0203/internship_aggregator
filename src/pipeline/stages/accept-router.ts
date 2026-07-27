import type { OpportunityType } from "@prisma/client";

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
