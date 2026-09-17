# Embedding model bake-off — eval gate results (Decision 31)

Ran 2026-09-14 against the approved profile fixture (real resume + questionnaire, edited
and thereby approved by the user per spec prerequisite 0). Sample, rankings, and labels in
`research/embedding-eval/` (vectors.json regenerable, gitignored). Metrics were
pre-registered in `finalized_decisions/recommendations.md` BEFORE any results existed.

**Verdict: GO — ship signature embeddings with `nomic-embed-text` (the existing default),
`W_FRESH = 0.05`, rank-based bands. Decision 31 stands; no amendment.** The raw baseline
won the primary P@10 by one noise-scale item but is disqualified on a pre-registered MUST
(soft-preference responsiveness — mechanism structurally dead under mxbai truncation).

## Setup

- Stratified sample: 200 active listings over 48 (csField × opportunityType) cells,
  largest-remainder allocation, deterministic id-asc draw → `sample.json`.
- Five approaches ranked the sample against the fixture profile:
  `sig:nomic`, `sig:mxbai` (distilled role-signature text, documented task prefixes),
  `raw:nomic`, `raw:mxbai` (title + descriptionPlain, 6,000-char cap — the honest
  no-distillation baseline; profile side = raw resume + soft questionnaire answers),
  `overlap` (deterministic skill-overlap + 0.5·field-match, no embeddings).
- Pooled labeling: union of every approach's top-10 → 35 unique listings, all labeled
  `relevant` / `borderline` / `irrelevant` by the user (~30 min). No approach's top-10
  contains an unjudged item.
- Held-out slice: every 5th labeled id (7 items) excluded from all selection metrics.

## Pre-registered results (selection slice, n=28)

P@10, **strict = borderline counts as NOT relevant (primary)**:

| approach | P@10 strict | P@10 lenient | soft-pref (swe in top-20) |
|---|---|---|---|
| sig:nomic | 0.30 | 0.80 | 15 → 17 ✓ |
| sig:mxbai | 0.30 | 0.70 | 17 → 20 ✓ |
| raw:nomic | 0.40 | 0.60 | — |
| **raw:mxbai** | **0.50** | 0.70 | **10 → 10 ✗ FAIL** |
| overlap | 0.20 | 0.80 | n/a |

Held-out final check: **uninformative** — all five approaches tied at P@7 strict 0.29
(2/7). Seven items cannot discriminate; the holdout serves as a sanity floor only.

Field clustering (diagnostic ONLY — csField leaks into signature text by design):
sig gaps 0.109 / 0.145 (nomic / mxbai) vs raw gaps 0.065 / 0.080 — signatures separate
fields better, as the leak predicts. Not a selection signal.

## Sensitivity: the two dead-link labels

Rows 220/221 (Cloudflare SWE Intern Fall 2026) were labeled `irrelevant` because
Cloudflare's careers page failed to render the deep link — a URL/UI failure, not a fit
judgment; both rows are live per the Greenhouse API (crawled 2026-09-13, `is_listed`).
Flipping them to their fit-truth (`relevant`):

| approach | strict as-labeled | strict corrected |
|---|---|---|
| sig:nomic | 0.30 | **0.40** |
| sig:mxbai | 0.30 | **0.40** |
| raw:mxbai | 0.50 | 0.50 (220 not in its top-10) |
| overlap | 0.20 | 0.30 |

Corrected gap: raw:mxbai 0.50 vs sig 0.40 — **one item at n=10**.

## Why raw:mxbai does not win

1. **It fails a pre-registered MUST.** The spec: "adding 'prefer swe' must measurably
   promote SWE listings" — the questionnaire's only soft mechanism. raw:mxbai moved
   0 listings (10 → 10). Cause is structural, not sampling luck: mxbai-embed-large
   truncates at 512 tokens; the raw profile query is the ~750-token resume with soft
   answers appended at the END — the model never sees them. Both signature approaches
   pass (short sectioned texts, no truncation).
2. **Its one-item edge is duplicate-inflated.** Its strict top-10 contains the Tulip
   Ecosystem Engineer Co-op/Intern/Working Student triplet — one role family, three rows,
   three "relevant" hits. Decision 28's card grouping collapses these to ~one card in the
   real UI, so listing-level P@10 overstates what the user experiences.
3. The held-out check cannot confirm the edge (all approaches tied).

Also observed: raw:nomic ranked three PhD-targeted research roles at positions 1–3
(labeled irrelevant) — raw text conflates academic seniority; signatures kept those out of
their top-10s. And `overlap`'s 0.20 strict (worst) answers the eval's design question:
embeddings DO add ordering value beyond extracted skills (though overlap's 0.80 lenient
shows skills alone find the right neighborhood).

Honest limitation: n=10 windows and a single profile-query mean strict differences of
0.10–0.20 are 1–2 items — this eval can rule out "signatures clearly win" and "baseline
cleanly wins," and it did both. It cannot resolve finer gaps; the disqualifier (soft-MUST)
is what makes the verdict decisive, and it was pre-registered.

## sig:nomic over sig:mxbai

Corrected primary: tied 0.40. Pre-registered secondary (lenient): nomic 0.90 vs mxbai
0.80 → nomic. mxbai showed stronger soft-response (17→20 vs 15→17) and a larger
clustering gap, but those are not the tiebreak metrics; nomic is also the incumbent
default, 768-dim (smaller vectors), and free of the 512-token cliff should profile text
ever grow. `mxbai-embed-large` remains pulled for future re-evals only.

## Freshness weight (pre-registered sanity check)

At the spec's starting `W_FRESH = 0.15`, the blend pulled 4–6 items into each approach's
top-10 that similarity alone excluded — most of them UNJUDGED (outside every pool) — with
cosine spread compressed to ~0.60–0.78, a 0..1 freshness term at 0.15 rivals the entire
similarity range. That is "remake," not "nudge." At `W_FRESH = 0.05`: 1–2 entrants,
zero labeled-irrelevant. **Chosen: 0.05** (config.ts), with the reorder magnitude as the
stated reason. No labeled-irrelevant item entered any top-10 at either weight.

## Band calibration (drives score.ts)

Labeled-class similarity distributions under sig:nomic (Cloudflare rows at fit-truth):

| label | n | max | median | min |
|---|---|---|---|---|
| relevant | 14 | 0.780 | 0.707 | 0.653 |
| borderline | 13 | 0.740 | 0.703 | 0.606 |
| irrelevant | 8 | 0.749 | 0.688 | 0.628 |

The classes overlap almost completely — the maximum IRRELEVANT score (0.749) exceeds the
median RELEVANT score. An absolute threshold cannot honestly say "strong match," while the
ordering demonstrably can (lenient P@10 0.80–0.90). Consequence: bands are RANK-based
(top ~10% of the eligible set = strong, next ~25% = good), claiming "among today's best
matches," which is all the data supports. The fixed thresholds shipped provisionally are
removed.

## Labeling-process notes (for the next eval)

- Dead deep-links caused two fit-mislabels; next round, label from the STORED description
  (the DB has it), not the employer's careers page.
- Full-time roles confused labeling ("didn't know how to classify") — resolved as
  `borderline` per the rubric (right work, adjacent stage). In production the types
  hard-filter removes them for this user anyway; the eval ranks unfiltered by design.
- Pooling was built on similarity-only rankings, but production ranks by blend — at
  W_FRESH 0.05 the difference is 1–2 items, accepted; a future eval should pool on the
  blended ranking. **[Done 2026-09-17: pool now ranks by `blendScore` with a pinned
  `pooledAt` recorded in rankings.json; score recovers the similarity-only order from
  stored sims. Same round added NDCG@10 (graded 2/1/0, secondary — strict P@10 stays the
  pre-registered primary), a `sigt:nomic` Template-v3 candidate (literal title line
  prepended to the signature text; nomic-only since mxbai is disqualified), and
  label carry-forward so re-pooling only ADDS rows to label.]**

## Addendum 2026-09-17 — Template v3 gate (title line): GO

Harness v2 round (blend pooling, pinned pooledAt; NDCG@10 secondary; labels carried
forward — marginal cost 7 new labels, 42 total, select n=34 / holdout n=8). Candidate
`sigt:nomic` = v2 signature text with the LITERAL `Title:` line prepended; same profile
vector; nomic only (mxbai stays disqualified). Criteria pre-stated: beat sig:nomic on
strict P@10, NDCG tiebreak, soft-preference MUST intact.

| approach | P@10 strict | P@10 lenient | NDCG@10 | soft-pref (swe top-20) |
|---|---|---|---|---|
| sig:nomic | 0.50 | 0.70 | 0.652 | 15 → 17 ✓ (14→16 this round) |
| **sigt:nomic** | **0.60** | 0.70 | **0.715** | 11 → 13 ✓ |
| raw:nomic | 0.40 | 0.70 | 0.449 | — |
| raw:mxbai | 0.40 | 0.80 | 0.695 | disqualified (2026-09-14 MUST) |
| overlap | 0.20 | 0.70 | 0.476 | n/a |

Held-out: all approaches tied at P@8 strict 0.50 (sanity floor only, again uninformative).

The entire strict gain is one explained swap: FeverUp "Becas de Excelencia" (irrelevant)
OUT, Virtu "Core Operations Engineer" (relevant title-term pull) IN — the exact mechanism
the title line predicts. Duplicate-inflation check clean (Varda/DRW pairs are distinct
roles; Cloudflare dead-link pair symmetric across approaches). Honest limitation stands:
one item at n=10; promotion leans on mechanism + NDCG corroboration + cheap reversal, not
on the margin alone. **Promoted as TEMPLATE_VERSION 3 — Decision 35.**
