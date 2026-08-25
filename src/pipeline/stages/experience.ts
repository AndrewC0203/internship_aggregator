// Years-of-experience parser (Decision 14). Reads the posting BODY and returns the smallest
// stated experience minimum, or null if the posting states none.
//
// This is deliberately a FACT extractor, not a policy: it answers "what minimum does this
// posting state?" and nothing else. The keep/drop threshold lives in filter.ts, so the policy
// can change (and become a stored column in v1) without touching this parsing logic.
//
// Why this exists: the local model anchors on the TITLE and under-weights the experience line
// in the body. All three keeps from the first real runs failed the same way — "Researcher"
// (2+ years UX) and "Data Analyst" (2+ years analytics) were kept as early-career, while
// "Junior Engineer" (0-3 years, "fresh graduates welcome") was correctly kept. See
// research/yoe-filter-analysis.md.

// Matches "2+ years", "0-3 years", "2 to 4 years", "5 year". The FIRST captured number is the
// stated minimum — that distinction is load-bearing: "0-3 years" has a minimum of 0 and is
// genuinely open to new grads, while "2+ years" has a minimum of 2 and is not. A regex that
// matched "any number + years" would drop the one posting of three that we correctly kept.
const YEARS = /(\d+)\s*\+?\s*(?:-|–|—|to)?\s*(\d+)?\s*\+?\s*years?/gi;

// Returns the SMALLEST stated minimum across all matches, or null if none found.
//
// Taking the minimum (not the maximum, not the first) is the keep-biased choice, and that is
// intentional: a false reject is invisible, so where a posting is self-contradictory we want
// the reading most favourable to keeping it. Concretely, "0-3 years required, 5+ preferred"
// resolves to 0 and survives.
export function minYearsExperience(descriptionPlain: string): number | null {
  let min: number | null = null;
  for (const match of descriptionPlain.matchAll(YEARS)) {
    const stated = Number(match[1]);
    if (!Number.isFinite(stated)) continue;
    if (min === null || stated < min) min = stated;
  }
  return min;
}

// Known limitations, accepted for the MVP (measured on 62 real matches across 6 boards, where
// none of these appeared — see research/yoe-filter-analysis.md):
//   - word-form numbers ("one year") are not matched
//   - month-form durations ("18+ months") are not matched
//   - reversed phrasing ("years of experience: 2+") is not matched
//   - tenure/benefit language ("401k vesting after 1 year") would read as a 1-year minimum if
//     it were the ONLY match in a posting; the min-across-matches rule limits the blast radius
// All four fail toward "no match" or a lower minimum, i.e. toward KEEPING the listing, except
// the last. Because these drops are never recorded (see filter.ts), widening the regex later
// retroactively re-evaluates everything it previously dropped.
