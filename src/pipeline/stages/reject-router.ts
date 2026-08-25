// Cheap regex reject-router. Fast-path DROPS titles that are unambiguously out of scope so
// they never reach the local model. This is the volume lever: measured on 2,008 real
// Greenhouse postings, ~100% of listings reached the model because the accept-router had
// almost nothing to fast-track (only 3 of 2,008 titles contained "intern"/"co-op" at all).
// See research/local-model-performance.md.
//
// ─── THE INVARIANT THAT MAKES THIS SAFE ────────────────────────────────────────────────
// A regex reject is NOT recorded in seen_listings. It is dropped in-place, every run.
//
// That is deliberate, and it is the whole safety story:
//   - seen_listings exists to memoize the EXPENSIVE model call (Decision 12). This regex is
//     free and deterministic, so memoizing it would save nothing — the next run would
//     re-reject the same title in microseconds anyway.
//   - Recording it, by contrast, would be permanent: partitionBySeen() routes anything in
//     seen_listings to seenRejects, which never reaches the model again. A regex bug would
//     silently delete listings forever, and because seen_listings is key-only (no title),
//     you could not even audit what you lost.
//   - Not recording it means a regex fix takes effect on the very next run, retroactively.
//
// So: never write a rejectRoute() drop to seen_listings. That single rule is what turns an
// irreversible decision into a reversible one.
//
// ─── PRECISION, AND WHY THE VETO COMES FIRST ───────────────────────────────────────────
// The accept-router is high-precision on ACCEPTS and lets everything else fall through to
// the model — its failure mode is "pay for an AI call we didn't need". This router inverts
// the blast radius: its failure mode is "the listing never appears". So it is high-precision
// on REJECTS, and the early-career veto below is the guard that enforces it.
//
// Concretely, the veto is what saves titles like "Associate Product Manager, New Grad (2027
// Start)" — a real posting that a naive seniority regex kills on the token "manager", but
// which CLASSIFY_SYSTEM says to keep (a technical product role IS cs_relevant, and new_grad
// is a valid type). A veto costs one model call. A false reject costs the listing.

// Early-career signals. If ANY of these appear, we refuse to regex-reject and defer to the
// model, no matter how senior or non-CS the rest of the title looks. Being generous here is
// cheap — the only cost of a false veto is one model call, which is the status quo anyway.
//
// "fellow" is deliberately in the VETO list and NOT the seniority list, even though
// "Distinguished Fellow" is a senior title: fellowship is one of our opportunity types, so
// the ambiguity must go to the model rather than being resolved by regex.
// "graduate" covers UK-style "Graduate Software Engineer" postings.
const EARLY_CAREER_VETO =
  /\b(intern|interns|internship|co-?op|new ?grad(uate)?s?|university|campus|apprentice(ship)?|entry[- ]level|early[- ]career|fellow(ship)?|graduate|phd|student|trainee|rotational|summer|winter|spring|fall)\b/i;

// Unambiguously non-CS job functions. Mirrors the "NOT cs_relevant" list in CLASSIFY_SYSTEM
// (sales, marketing, HR, finance, recruiting, operations, non-technical design).
//
// Deliberately OMITTED as too ambiguous to reject by regex:
//   - "support" — "Technical Support Engineer" is arguably CS-adjacent
//   - "design"  — "Design Engineer" / "Chip Design" are technical
//   - "analyst" — "Data Analyst" / "Security Analyst" are CS-adjacent
//   - "product" — "Product Engineer" is technical; bare "Product Manager" is caught by
//                 seniority instead
// Anything omitted here simply falls through to the model, which is the safe direction.
const NON_CS_FUNCTION =
  /\b(sales|salesforce admin|marketing|brand|communications|public relations|\bpr\b|recruit(er|ers|ing|ment)?|talent acquisition|human resources|\bhr\b|people operations|payroll|benefits administrator|finance|financial planning|accounting|accountant|controller|bookkeep\w*|\btax\b|auditor|legal|counsel|paralegal|contracts manager|customer success|account executive|account manager|business development|partnerships|office manager|facilities|janitor\w*|custodian|executive assistant|administrative assistant|receptionist|warehouse|driver|courier|nurse|nursing|clinical|physician|pharmacist|therapist|teacher|tutor|barista|chef|cook|server|bartender|cashier|retail associate|real estate|leasing|procurement|merchandis\w*)\b/i;

// Seniority / experience markers. A role at this level is not early-career, so per
// CLASSIFY_SYSTEM its opportunity_type would be null and it would be rejected anyway —
// EVEN IF it is cs_relevant. Catching that here is the bulk of the savings, since most
// company job boards are dominated by experienced roles.
//
// Deliberately OMITTED: level suffixes (II / III / IV). They read as seniority to a human
// but are too easy to mis-match ("Tier II Support", stray roman numerals), and the downside
// of a wrong reject outweighs the extra savings. Let the model handle them.
const SENIORITY =
  /\b(senior|sr\.?|staff|principal|distinguished|lead|leader|manager|management|director|head of|chief|\bvp\b|vice president|president|executive|architect|supervisor|foreman)\b/i;

// Returns true if this title can be dropped WITHOUT a model call.
//
// Callers MUST NOT record a `true` result in seen_listings — see the invariant above.
export function rejectRoute(title: string): boolean {
  // Veto first: an early-career signal always wins over the reject rules below.
  if (EARLY_CAREER_VETO.test(title)) return false;
  return NON_CS_FUNCTION.test(title) || SENIORITY.test(title);
}
