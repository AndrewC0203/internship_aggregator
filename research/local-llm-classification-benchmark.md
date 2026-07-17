# Local LLM for Field Extraction — Benchmark Results

**Date:** 2026-07-13
**Hardware:** MacBook Pro, Apple M4 Pro, 24 GB unified memory, 16 GPU cores
**Runtime:** Ollama 0.30.8
**Question:** Can a locally-run model reliably classify internships and extract grad-year
requirements from ATS postings, and is compute a bottleneck?

---

## Scope correction (important)

The original question bundled five fields. Three of them should **never** touch a model:

| Field | Verdict | Why |
|---|---|---|
| **Company name** | **No LLM** | It's the slug you queried (`/boards/stripe/jobs`). Known with certainty, free. An LLM can only add hallucination + naming inconsistency ("Stripe" vs "Stripe, Inc.") — which would *create* a dedup problem. |
| **Dates** | **No LLM** | All three APIs give structured timestamps. Only issue is format (Lever = epoch-ms, others ISO). One-line conversion, exact and deterministic. |
| **Employment type** | **LLM for Greenhouse only** | Ashby has `employmentType: "Intern"`. Lever has `categories.commitment: "Internship"`. **Only Greenhouse ships no employment-type field at all.** |
| **Grad year** | **LLM — genuine** | Buried in 4–10 KB free text, dozens of phrasings, no structured field in any API. |
| **Internship-equivalents** | **LLM — genuine, best case** | "Binance Accelerator Program", "Part-Time Student Worker", "Spring Co-op". Fuzzy semantic judgment; regex fundamentally cannot do this. |

---

## Test set

35 hand-labeled postings pulled live from a 6,433-posting pool (23 companies across all three
ATSs). Deliberately adversarial: 17 positive / 18 negative.

- **explicit (13)** — "Software Engineer, Intern" etc.
- **equivalent (4)** — internships with no "intern" token: Binance Accelerator Program,
  2× Zoox "Part-Time Student Worker", Shield AI "Spring Co-op"
- **trap (9)** — contain the substring `intern` but are NOT internships:
  "Software Engineer, **Intern**al Systems" (Stripe), "Software Engineer - Database Engine
  **Intern**als" (Databricks), "Software Engineer, **Intern**ational" (Ramp), internal-audit roles
- **newgrad (5)** — full-time "New Grad" / "PhD Early Career" roles. **Labeled NOT internships**
  (they're permanent jobs). ← *this is a spec decision; if you disagree, labels change*
- **negative (4)** — ordinary senior/staff roles

---

## Result 1 — Internship classification (trustworthy)

| Approach | Accuracy | False pos | False neg | Speed/posting |
|---|---|---|---|---|
| Naive regex (`intern` in title) | 62.9% | 9 | 4 | instant |
| Smart regex (minus `internal`/`international`) | 88.6% | **0** | 4 | instant |
| **qwen3.5:4b** (3.4 GB) | **97.1%** | 0 | 1 | **2.06 s** |
| **gemma4:12b** (7.6 GB) | **100%** | 0 | 0 | 4.95 s |
| **qwen3:14b** (9.3 GB) | **100%** | 0 | 0 | 4.55 s |

**The smart regex is better than expected** — it nails every trap, zero false positives. Its
entire failure mode is the 4 equivalents, which it *cannot* see (no "intern" token exists in them).

**That gap is the whole value of the model.** All three models caught all four equivalents while
holding zero false positives on the traps.

- `qwen3.5:4b`'s single miss was an internal contradiction: it returned
  `is_internship=false` while simultaneously setting `category="internship"` in the same JSON
  object. Cheap to catch with a consistency assertion.
- Zero JSON parse failures across all 105 calls (Ollama's `format` schema-constrained decoding).
- `think:false` is essential for qwen3 — it's a reasoning model and thinking blocks would
  balloon latency.

## Result 2 — Grad-year extraction (numbers unreliable, finding still clear)

**Methodological failure, disclosed:** I built the grad-year gold set with a regex. The regex was
incomplete, so several model outputs I initially scored as "false positives" were **verified
verbatim in the source descriptions** — the models were right and my ground truth was wrong.
Examples the regex missed but the models found:

- Replit — "Have at least one semester of schooling remaining after the internship completion"
- Neuralink — "Currently pursuing a Bachelor's degree in Computer Science"
- Databricks — "Pursuing a PhD in computer science or related fields"
- Stripe (New Grad) — "degree… obtained by summer 2026"

**Therefore precision/recall figures here are NOT trustworthy.** A hand-labeled gold set is
required before any number is quotable. What *is* solid:

| Model | Extraction behavior | Hallucinations |
|---|---|---|
| qwen3.5:4b | **Severe under-extraction.** Returned null on essentially every real requirement (0/6 on labeled golds, 1/35 overall). Not *wrong* — silent. | 0 |
| gemma4:12b | Consistently pulled real requirements, incl. several my gold missed | 0 |
| qwen3:14b | Similar to gemma4; missed Binance which gemma4 caught | 0 |

**Zero hallucinated extractions across all three models** — every extraction was verbatim source
text. This is the strongest single result in the benchmark.

**The 4B is good enough to classify but not to extract.** That asymmetry drives the design below.

## Result 3 — Compute is NOT the bottleneck

Measured throughput (M4 Pro, 24 GB):

| Model | Prompt eval | Generation | Mean latency |
|---|---|---|---|
| qwen3.5:4b | 735 tok/s | 51 tok/s | 2.06 s |
| gemma4:12b | 283 tok/s | 24 tok/s | 4.95 s |
| qwen3:14b | 261 tok/s | 25 tok/s | 4.55 s |

**Cascade design** — measured against the real 6,433-posting pool:

| Stage | Postings | LLM calls |
|---|---|---|
| 1. Structured field exists (Lever + Ashby) | 4,114 (64%) | **0 — free** |
| 2. Greenhouse, obvious title resolved by rule | 1,447 | **0 — free** |
| 3. Genuinely ambiguous → LLM | **791 (12.3%)** | 791 |
| 4. Grad-year extraction (confirmed internships only) | **70** | 70 |

Only **861 of 6,433 postings (13%)** need a model at all.

| Model | Naive (LLM on all 6,433) | **Cascade (861)** |
|---|---|---|
| qwen3.5:4b | 3.7 h | **0.49 h** |
| gemma4:12b | 8.8 h | **1.18 h** |
| qwen3:14b | 8.1 h | **1.09 h** |

And this is a **one-time cost per posting** — cache the verdict; postings are near-immutable.
Steady state is only the daily delta (tens to low hundreds of new postings = minutes/day).
Scaled to ~500 companies (~20× this pool), backfill is roughly 10–24 h once, overnight.

---

## Findings

1. **`qwen3:14b` is dominated.** Same 100% classification as `gemma4:12b`, no better at
   extraction (actually missed one gemma4 caught), 1.7 GB larger, and it over-extracts more.
   No reason to pick it.

2. **The real trade is `qwen3.5:4b` vs `gemma4:12b`:** 2.4× faster and 97% at classification,
   but effectively useless at extraction — vs 100% + reliable extraction at 2.4× the latency.

3. **A hybrid is available and cheap.** Grad-year extraction runs on only ~70 confirmed
   internships — a *tiny* set. So you can afford the expensive model exactly where it's needed:
   `qwen3.5:4b` for the 791 ambiguous classifications (fast), `gemma4:12b` for the ~70
   extractions (accurate). Best of both, negligible extra cost.

4. **Keep the regex.** It resolves ~88% of cases for free and is deterministic. The model is a
   *fallback for the ambiguous tail*, not a replacement. Never send a posting to a model when a
   structured field already answers the question.

5. **The evaluation is the hard part, not the inference.** I got burned by a regex-built gold
   set inside this very benchmark. Before trusting any of this in production, hand-label a real
   eval set — that set is the actual deliverable, and it's what makes the numbers defensible.

---

## Open decision (GATED — not made)

Which model(s), and whether to adopt the hybrid. Compute is not a constraint; accuracy on
extraction and the cost of maintaining an eval set are the real trade-offs.
