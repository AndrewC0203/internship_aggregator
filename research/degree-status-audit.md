# Degree-status filter audit

**Date:** 2026-08-28
**Trigger:** internships mislabeled where the posting requires an already-completed degree
(post-grad hire) rather than being open to a student pursuing one. No code changed — audit only.

## Finding: no degree-completion signal exists anywhere in the pipeline

- `prisma/schema.prisma` — `Listing` has `gradYearMin/Max` (derived from stated grad-date text)
  and `citizenshipStatus`. No `degreeStatus` field.
- `CLASSIFY_SYSTEM` (src/model/classifier.ts) overrides the title on stated *years of
  experience* only. No instruction checks degree-completion language.
- `EXTRACT_SYSTEM` (src/model/classifier.ts) extracts grad dates / citizenship / deadline.
  No degree-completion field.
- No regex tier (accept-router, reject-router, experience.ts) touches this either.

## DB evidence (663 `opportunity_type='internship'` rows at time of audit)

**A bare "PhD"/"Bachelor's" keyword regex would be wrong.** The dominant, *correct* phrasing at
quant/hardware shops is "Are pursuing a Bachelor's, Master's, or PhD in ..." (DRW: listings
287, 291, 292, 294, 296, 300, 301, 303, 304, 310, 312, 313 — all legitimately early-career).
Flagging on the token "PhD" alone would false-reject these.

**A real instance of the bug exists.** Listing 1629, WhiteWater Midstream, "Data Science Intern
- Summer 2027": `opportunityType=internship`, `gradYearMin/Max=2028`. Body has no
pursuing/enrolled language — "Bachelor's degree in Business, Finance, Economics, Mathematics...
required" — and states outright: *"This role is the natural next step for graduates of WWM's
Natural Gas Analyst / Data Science Internship."* This is a post-internship hire, mislabeled as
an internship with a fabricated grad year.

**Architecturally, that listing never reached the classify model.** Its title matched
`acceptRoute()` (CS signal + intern signal in the title), so Pass 1 (`classify`) was skipped
entirely — it went straight to `keeps`. Only Pass 2 (`extract`) ran on it. `extract` is the
only stage guaranteed to run on 100% of keeps regardless of path (router-accept, router-reject
survivor via model, or straight model keep) — a title-only regex fix cannot catch this class of
error because the title alone looks like a clean internship.

**Ambiguous case, for calibration.** Listing 397, Virtu Financial, "Quantitative Researcher
(PhD)": body says "Advanced degree (preferably PhD)" with no explicit pursuing/enrolled
language, but earlier text frames the program as aimed at "graduate students." Genuinely
ambiguous by regex; the kind of case an abstain-when-unsure model field handles better than a
keyword rule.

## Unrelated finding surfaced during the same audit: extract hallucination

Listings 1065/1066 (SpaceX, "Summer 2027 Silicon/Software Engineering Internship/Co-op") have
`gradDateMin/Max = "2024-09"`. That string does not appear anywhere in the description text —
the model invented it, violating EXTRACT_SYSTEM's own "do NOT guess" instruction. Not a
degree-status issue, but it weakens confidence in `gradYear` as a filter signal generally and
is worth a follow-up look independent of this work.

> **Status update (2026-08-28, same day):** implemented as Decision 24 — `degree_status` on
> the extract pass with quote-first grounding (`degree_evidence` emitted before the enum in
> schema order). Measured on the cases below: plain prompt = 0/3 correct (title-anchored to
> "pursuing" every time, across two phrasings); quote-first = WhiteWater →
> completed_required, DRW → pursuing, no-degree-mention control (#1237) → null. See
> DECISIONS.md Decision 24.

## Recommendation (implemented — see status update above)

Do not add a pre-model regex tier for this (unlike YOE's tight "N+ years" numeric pattern,
"pursuing" vs "already has" spans too much phrasing variance, and the DRW evidence shows a bare
keyword match would false-reject good listings).

Add a `degreeStatus` field (`pursuing` / `completed_required` / `unknown`) to the **extract**
pass — same call, same abstain-when-unsure philosophy as `citizenshipStatus` — because extract
is the only stage that sees every keep, including accept-router fast-path listings like
WhiteWater.

Open policy question, not yet decided: what happens when `degreeStatus=completed_required`
meets `opportunityType=internship`. Leaning toward store + surface rather than auto-drop, given
only one confirmed violation in 663 sampled internships and the codebase's existing
false-reject-is-invisible-and-permanent principle (reject-router.ts, experience.ts).
