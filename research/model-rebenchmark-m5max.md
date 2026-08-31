# 7B vs 14B re-benchmark on the M5 Max (2026-08-30)

Machine upgrade (M4 Pro 24GB → **M5 Max 128GB**) removed the RAM ceiling that forced the
7B default (see research/local-model-performance.md, Decision 13 context). This re-measures
both speed and verdict quality on current prompts — including the new Decision 24
degree-status field — to decide whether the default should move back to 14B.

## Method

35 listings: every 54th active listing by id (deterministic stride over 1,623) plus the 4
degree-status gold cases from research/degree-status-audit.md. Both passes (classify +
extract) run per listing per model, warm model, timed per call. Same prompts, same code
path as production (`src/model/classifier.ts`). Disagreements adjudicated by reading the
actual posting text.

## Latency (warm, real listings)

| per call | 7B mean | 14B mean | ratio |
|---|---|---|---|
| classify | 2.32 s | 2.65 s | **1.14×** |
| extract | 2.15 s | 4.94 s | **2.30×** |
| both passes / listing | 4.47 s | 7.59 s | 1.70× |

Two notable shifts from the 2026-08-04 numbers:

- **The M5 Max helped the 14B far more than the 7B.** 14B classify fell 7.41s → 2.65s
  (2.8×); 7B classify fell 3.61s → 2.32s (1.6×). The workload is prefill-bound and the new
  memory bandwidth mostly erases the parameter-count prefill penalty.
- **The models now diverge on decode, not prefill.** Classify emits ~20 tokens (near-free
  everywhere); extract emits the degree_evidence quote + six fields, so the 14B's slower
  decode shows only there. Classify on the 14B is nearly free relative to 7B (+0.33s).

## Full-sweep cost (1,623 active listings, `reclassify -- --extract`)

| | 7B | 14B |
|---|---|---|
| estimated wall | **~2.0 h** | **~3.4 h** |

Daily refresh delta is much smaller: the reject-router keeps ~82% of titles away from the
model, and extract runs only on keeps.

## Classify verdicts: 8/35 disagreements (23%) — adjudicated

All sampled rows are current keeps, so a 14B reject = candidate false keep in the live hub.
Verified against posting text:

| id | listing | 7B | 14B | who's right |
|---|---|---|---|---|
| 505 | Core One "Security Associate" | keep (new_grad) | reject | **14B** — clearance/facility security admin ("maintain security records", under an FSO), not cybersecurity |
| 621 | Monks "[Campus Monks] Estágio em CRO" | keep (internship) | reject | **14B** — conversion-rate-optimization marketing internship |
| 740 | Hyphen "AI驅動的產品開發通才" | keep (new_grad) | reject | 14B (borderline) — product-development generalist |
| 1112 | "Spring 2027 Data Science Intern" | co_op | internship | **14B** — single spring term; no multi-term evidence for co_op |
| 1237 | InterWorks "IT Intern" | keep (internship) | reject | **14B** — day-to-day IT support / desktop management = service-side IT, explicitly out of scope per CLASSIFY_SYSTEM |
| 1347 | Outfit7 "Talent Pool for Student Collaboration" | keep (internship) | reject | **14B** — a talent pool, not a posting |
| 1702 | CSIS "Research Intern - Korea Chair" | keep (internship) | reject | **14B** — foreign-policy research, not CS |
| 1826 | BVP "Summer Analyst 2027" | keep (internship) | reject | **14B** — VC analyst program ("accounting, investing") |

**Score: 14B correct on 7–8 of 8; the 7B was not clearly right on any.** Every 7B error is
a false keep, consistent with the documented title-anchoring bias. Extrapolated, roughly
**15–20% of current active rows are junk the 14B would remove** — this is the largest
data-quality lever measured since the reject-router, and it directly serves the <5%-junk
spirit of the success metrics.

## Extract verdicts — more mixed

**Degree status (10/35 differ):** the 14B finds `pursuing` where the 7B returned null on
several genuine internships (#1290, #1766, #1347, #1169) — higher sensitivity, likely
correct. But the flagship WhiteWater case (#1629) is **contested**: 7B says
completed_required (matching the audit reading: "Bachelor's degree ... required", "natural
next step for graduates of WWM's internship"), 14B says pursuing (defensible via the
posting's own "preferably a May 2028 grad" line — the posting is self-contradictory).
Unverified: #678/#6/#1407 where 14B says completed_required.

**Grad dates (7/35 differ):** the 14B fills windows the 7B missed (#991, #1169, #1290) but
produced at least one clear hallucination: **#139 Astranis "(Fall 2026)" → grad window
2026-09..2026-12** — that Fall 2026 is the program's start term, not a stated graduation
window; the text actually says "students who have already received a bachelor's degree."
The 14B converted a season into a grad requirement against the prompt's explicit
instruction. 7B's null was correct there.

## Recommendation (not yet decided — GATED, amends Decision 13's model choice)

1. **Switch classify to 14B, keep extract on 7B** — captures the unambiguous win (CS
   relevance) at +0.33s/call (~+9 min on a full sweep vs today), avoids the 14B's
   extract-side hallucination risk. Requires a small change: per-call model override
   instead of one global `OLLAMA_MODEL`.
2. **Switch both to 14B** — simplest, best degree/grad sensitivity, accepts the #139-style
   grad-date hallucination risk and ~3.4h sweeps (1.7×).
3. **Stay on 7B** — no longer defensible on this evidence: 7–8 confirmed false keeps in a
   35-row sample is a hub-quality problem the router can't fix.

My recommendation: **option 1**. The classify delta is decisive and nearly free; the
extract delta is mixed on this sample. Re-evaluate extract's model after the degree-status
backfill produces more ground truth.

Artifacts: raw per-call JSONL + logs in the session scratchpad (bench-7b/14b.jsonl);
regenerate with the same stride to reproduce.
