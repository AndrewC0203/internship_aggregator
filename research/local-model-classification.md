# Local model for classification + extraction

Reference notes behind the model choice in DECISIONS.md Decision 12. Raw exploration — the
settled spec lives in `finalized_decisions/classification-extraction.md`.

## Task shape

Two jobs share one local model (FEATURES.md "one path, not many"):

1. **Classify** each not-yet-seen listing: is it CS-adjacent AND an in-scope opportunity type
   (internship | co_op | fellowship | new_grad | research | part_time)? Output the type or a
   reject.
2. **Extract** (survivors only): grad_year_min/max, citizenship_status enum, application
   deadline — from `description_plain`. Must abstain (null) when unsure (Decisions 7, and the
   FEATURES deadline/citizenship rules).

Both want **strict JSON** out and run as a **batch** job (nightly), so accuracy matters more
than latency; the expensive part is the one-time initial sweep over all boards.

## Hardware

MacBook, Apple **M4 Pro, 24 GB unified memory**. Ollama runs models on the Metal backend.
24 GB comfortably fits a 14B model at 4-bit quant (~9 GB weights) alongside macOS + Node +
local Postgres, with headroom. A 32B (~19 GB) would fit but leaves little room and runs slow;
not worth it here.

## Candidates considered

| Model | Q4 size | Notes for this task |
|---|---|---|
| **Qwen2.5-14B-Instruct** | ~9 GB | Strong instruction-following + JSON adherence; best accuracy that still fits 24 GB comfortably. Chosen primary. |
| **Qwen2.5-7B-Instruct** | ~4.7 GB | Excellent for its size, ~2× the throughput of 14B. Chosen as the fallback if the initial 14B sweep is too slow. |
| Llama-3.1-8B-Instruct | ~4.9 GB | Solid; Qwen2.5 generally edges it on strict structured extraction / JSON. |
| Phi-3.5 / Phi-4 | small | Fast, but less reliable on strict JSON under varied prompts. |
| Gemma-2-9B | ~5.5 GB | Good general quality; Qwen2.5 preferred for JSON discipline. |

Zero-shot classifiers (BART-MNLI / cross-encoders) were ruled out at the architecture level
(Decision 12 option A2): they'd label the type but not do extraction, which fights the
"one path" constraint. Cloud (Haiku, A3) was ruled out on the "local unless <$1/day" bar —
see Decision 12's cost analysis; it only lands under $1/day if rejects are remembered, and the
user chose local anyway.

## Throughput sanity check (why accuracy-over-speed is affordable)

Rough, M4 Pro, Q4:
- 14B ≈ 15–25 tok/s; 7B ≈ 30–50 tok/s (varies with context length).
- Per classify call ≈ ~800 input + ~130 output tokens.
- Initial sweep classifies ~all jobs (~6.5k at 163 boards). At 14B this is a **multi-hour**
  background run; 7B roughly halves it. Extraction runs only on the few hundred keeps, so it's
  cheap.
- Steady state: the partition-by-seen step means only genuinely-new postings reach the model —
  minutes/day. So the 14B accuracy cost is paid mostly once.

If the initial 14B run is annoyingly slow, drop to 7B for the sweep and optionally re-run
borderline cases on 14B. This is a tuning lever, not a re-decision.

## JSON enforcement

Regardless of model, enforce structured output so parsing never depends on the model
"remembering" to emit valid JSON:
- Ollama supports `format: "json"` and, better, a JSON-schema-constrained `format` (grammar).
  Use a schema that encodes the classify output (`{ cs_relevant: bool, opportunity_type: enum|null }`)
  and the extract output (`{ grad_year_min: int|null, grad_year_max: int|null,
  citizenship_status: enum|null, application_deadline: date|null }`).
- Prompt the extract pass to return null on uncertainty (don't guess a grad year off a salary
  figure or a program end-date off a deadline). This is the existing Decision 7 / FEATURES rule.

## Open tuning (not decisions)

- Exact prompt wording for the fuzzy CS-adjacency boundary (quant / PM / design) — expect to
  iterate against a small labeled sample.
- Whether to keep 14B for the whole sweep or split sweep=7B / borderline=14B.
- Few-shot examples in the classify prompt if precision at the boundary is low.
