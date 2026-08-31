// Turns a board slug ("two-sigma", "gitlab") into a display-ish company name ("Two Sigma",
// "Gitlab") for sources whose posting payload never states a company at all — Lever and
// Ashby are both one-board-per-company, so it's implicit in which board you queried, not a
// field in the response (verified against research/ats-field-reference.md's field tables;
// neither has a "company" row). Shared because both sources hit the identical gap.
//
// Splits on separators AND whitespace, then title-cases each word — the whitespace split is
// load-bearing for idempotency: the orchestrator may pass either a raw slug ("two-sigma") on
// a board's first crawl, or an already-prettified name ("Two Sigma") learned back from a
// prior crawl (Decision 22's company cache). Re-running this on "Two Sigma" must return "Two
// Sigma" unchanged, not corrupt the second word by treating the whole string as one token.
//
// Best-effort only, not a guaranteed-correct display name: a slug's casing doesn't always
// match the real one ("gitlab" -> "Gitlab", not "GitLab"). Accepted per Decision 15's own
// tradeoff — an imperfect company string still dedupes fine within one source; it only risks
// a missed CROSS-source match, which is dedup's already-logged safe failure direction.
export function prettifyCompanySlug(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
