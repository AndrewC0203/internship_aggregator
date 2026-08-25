# Years-of-experience filtering — measurement (2026-08-09)

Raw exploration for an UNDECIDED question: how to stop false keeps where a posting states a
professional-experience minimum but the title reads early-career. Not a settled spec.

## The problem

The first real runs produced 3 keeps; 2 were wrong, and all 3 failed the same way — 7B anchors
on the TITLE and under-weights the experience line in the body. See
`local-model-performance.md` for the model-side analysis.

| listing | stated requirement | 7B verdict | correct? |
|---|---|---|---|
| Junior Engineer @ 2K | "0–3 years (excellent fresh graduates are welcome)" | `new_grad` | ✓ |
| Researcher @ 2K | "2+ years of UX or other social science research" | `research` | ✗ |
| Data Analyst @ 1stdibs | "2+ years in data or product analytics" | `new_grad` | ✗ |

## Does a regex work?

Tested `(\d+)\s*\+?\s*(?:-|–|to)?\s*(\d+)?\s*\+?\s*years?` against those three postings — one
clean hit each, no noise:

```
Junior Engineer   "0–3 years"
Researcher        "2+ years"
Data Analyst      "2+ years"
```

**The load-bearing detail: parse the MINIMUM of the range.** `0–3` → 0 → keepable;
`2+` → 2 → rejectable. A regex matching "any number + years" would kill the Junior Engineer,
which is the one correct keep of the three.

## Corpus scan

5 boards (2k, abnormalsecurity, 6sense, addepar1, 1stdibscom), counting only titles that
survive `rejectRoute()` — i.e. the population that actually reaches the model:

| | count | share |
|---|---|---|
| postings reaching the model | 69 | — |
| contain a "N years" phrase | 55 | 80% |
| **minimum ≥ 2 (rejectable)** | **43** | **62%** |
| minimum 0 or 1 (keepable) | 7 | 10% |

If a body-level YOE check ran before the model, calls on this sample would fall from 69 to
~26 — roughly a further **2.6×** on top of Decision 13's gains.

## The risk I looked for and did NOT find

Hypothesis: internship postings say things like "must have completed 2+ years of undergraduate
coursework", where the number describes STUDY, not employment — acting on it would be a false
reject. A context heuristic flagged 5 candidates, but on inspection all 5 were either genuine
professional-experience minimums ("6+ years of professional experience", near the word
"degree" only incidentally) or ranges starting at 0 ("0 to 1 year (Fresh graduates)").

**Zero true instances found — but this is weak evidence.** The sample is an August corpus with
almost no internship postings in it, which is exactly the population where the risk would
live. Treat as UNTESTED, not disproven. Re-run against an internship-heavy board in September.

## Cutoff-0 scan (6 boards, 90 postings) — the numbers Decision 14 was made on

Cutoff 0 rejects any stated minimum >= 1, so precision matters much more than at cutoff 2.
Counting only titles that survive `rejectRoute()`:

| | count |
|---|---|
| titles reaching the model | 90 |
| no "N years" phrase at all → still go to the model | 33 |
| minimum 0 → kept | 2 |
| minimum 1 → dropped | 7 |
| minimum 2+ → dropped | 48 |
| **model calls after the filter** | **35 (39% of 90)** |

**No proximity gate needed.** 58 of 62 matches (94%) sit next to an experience word, and all
4 that do not were still genuine requirements ("4+ years in large-scale production networks",
"1+ years building and operating applied ML"). Requiring proximity would have LOST true
positives, so the plain regex is the better one.

Still zero true study-context instances found — and still an August corpus, so the risk
remains untested rather than disproven.

## Verification on the three motivating postings (2026-08-09)

| posting | regex minYears | outcome |
|---|---|---|
| Junior Engineer @ 2K | 0 | → model → kept ✓ |
| Researcher @ 2K | 2 | dropped pre-model ✓ |
| Data Analyst @ 1stdibs | 2 | dropped pre-model ✓ |

**Option D (prompt hardening) is a PARTIAL fix.** With the new `CLASSIFY_SYSTEM` wording, 7B
now returns `null` for Data Analyst (was `new_grad`) but still returns `research` for
Researcher. The regex is what guarantees both; treat the prompt as a second layer, not the fix.

## Options on the table (A + D chosen — see DECISIONS.md Decision 14)

- **A. Body-level YOE regex before the model.** Catches 43/69 here. Free. Reversible if drops
  go unrecorded (the Decision 13 rule). Fails on study-vs-work ambiguity.
- **B. `extract()` does it.** Already reads the body and pulls grad year, so
  `min_years_experience` is a natural sibling. But extract runs only on KEEPS after classify,
  so it buys correctness, not speed — and it moves a stage boundary (`extract()` would have to
  return late rejects for `persist()`).
- **C. Add `min_years_experience` to the CLASSIFY schema.** Same call, ~5 extra output tokens
  (negligible while prefill-bound). Model extracts the fact, code applies the threshold. Needs
  the same clamping guard as grad years — schema-valid ≠ semantically right.
- **D. Prompt-only fix to `CLASSIFY_SYSTEM`.** Free, nothing structural. The current prompt
  never states the rule, so it is untested rather than proven inadequate.

A and D compose with anything; B and C are alternatives.

## Open questions blocking the decision

1. **Reject or record?** Should a YOE minimum DROP the listing, or become a stored column
   filtered at read time (the reversible path, cf. Decision 10's treatment of
   `opportunity_type`)?
2. **What is the cutoff?** Is 2+ always disqualifying? Does "0–2 years" stay? This is policy,
   not measurement.
