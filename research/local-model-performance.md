# Local model performance analysis (2026-08-04)

Measured to answer: is `qwen2.5:14b-instruct` the right model, or is a cheaper one enough?
Feeds the open model/classification-strategy decision (successor to Decision 12).

## Machine

M4 Pro (Mac16,8), 24 GB unified memory, 12 cores. Ollama 0.32.5.

## Model as configured

`qwen2.5:14b-instruct` — 9.0 GB on disk, **9.5 GB resident**, 100% GPU, 4096 ctx.
Resident memory drops system free memory to ~21%; `vm_stat` showed 244k pageouts.
Ollama keeps the model loaded ~4 min after each call, so it is effectively always
resident during a refresh run.

## Latency: classify call, steady state

8 unique prompts (varied text so Ollama's prefix cache could not mask prefill cost).
Synthetic 6000-char descriptions matching `MAX_DESC_CHARS`.

| metric | value |
|---|---|
| wall | **7.41 s** |
| prefill | 6.42 s (**87%**) |
| decode | 0.82 s (11%) |
| prefill throughput | ~226 tok/s |
| decode throughput | ~25 tok/s |
| tokens | ~1,450 in / ~21 out |

**The workload is prefill-bound.** Decode speed — the number usually quoted for local
models — is 11% of runtime and not the lever. Prefill is linear in input length, so
input size and call volume dominate, not decode.

Cold load adds ~5.2 s once per model load.

## Real corpus: 2,008 postings, 8 Greenhouse boards

Boards: acquia, acuitymd, addepar1 (from `crawl_targets`) + gitlab, stripe, databricks,
flexport, affirm (added for volume).

**Description length** (`description_plain`, after HTML strip):

| min | p25 | median | p75 | p90 | max | mean |
|---|---|---|---|---|---|---|
| 2,360 | 5,521 | **6,997** | 8,422 | 10,201 | 17,455 | 7,147 |

**68% exceed `MAX_DESC_CHARS = 6000`** — nearly every call is a maximum-size prompt.

**Accept-router hit rate**: **1 / 2,008 (0.05%)**. Only **3 of 2,008 titles** contain
"intern" or "co-op" at all. The router requires a CS signal AND an intern signal in the
title, so it has almost nothing to fast-track: ~100% of listings reach the model.

> ⚠️ **Seasonal caveat, unverified.** Sampled in early August; summer-2027 internship
> postings largely are not posted yet. The 0.05% rate may be seasonal rather than
> structural. Re-measure against a known internship-heavy board before treating it as
> permanent — this materially changes the value of a pre-filter.

## Implied cost

2,008 listings × 7.41 s ≈ **4.1 hours** for the classify pass alone, before `extract()`
makes a second ~1,450-token call on every keep. Consistent with the observed run that
reached ~210 of 1,599 after several hours.

## Levers (not yet decided)

| lever | est. effect | main cost |
|---|---|---|
| A. Smaller model (7B / 3B) | **~2× (7B, estimated — not measured)**; resident 9.5 → ~5 GB | accuracy on exactly the ambiguous cases the router defers |
| B. Smaller `MAX_DESC_CHARS` | linear: 6000 → 2000 ≈ 3×, any model | grad-year / visa / deadline signals sit late in postings; hurts `extract` more than `classify` |
| C. Cheap pre-filter / title-level reject | up to ~100× if most listings are rejectable on title | false rejects are **permanent** — `filter.ts` writes to `seen_listings`, never re-checked |
| D. Merge classify + extract into one call | ~2× on keeps | longer prompt; harder to preserve extract's abstain-when-unsure discipline |

B and C are independent of A and compose with it.

## 7B measured (2026-08-04) — Decision 13 adopted this as the default

Same harness, same 6000-char prompts:

| | 14B | 7B | ratio |
|---|---|---|---|
| wall | 7.41 s | **3.61 s** | **2.05× faster** |
| prefill | 6.42 s (87%) | 3.09 s (86%) | 2.08× |
| decode | 0.82 s | 0.42 s | 1.95× |
| prefill throughput | 226 tok/s | 470 tok/s | 2.08× |
| decode throughput | 25 tok/s | 47 tok/s | 1.9× |
| resident memory | 9.5 GB | **4.7 GB** | |
| system free memory | 21% | **63%** | |

Both models remain prefill-bound at ~86–87%, confirming the diagnosis: the win comes from
parameter count scaling prefill, not from faster generation.

On the 6 synthetic probe titles the two models returned **identical verdicts** (including
correctly rejecting "Senior Staff Backend Engineer" and "Product Marketing Manager", and
correctly typing a co-op and a fellowship). Six titles is not an accuracy evaluation —
see "Not measured" below.

## Reject-router measured (2026-08-04)

`src/pipeline/stages/reject-router.ts`, on the same 2,008 real titles:

| | count | share |
|---|---|---|
| accept-router keeps | 1 | 0.05% |
| **reject-router drops** | **1,653** | **82.2%** |
| reach the model | 356 | 17.7% |
| early-career titles wrongly dropped | **0** | — |

A naive first-draft version *without* the early-career veto dropped 13 early-career titles,
including `Associate Product Manager, New Grad (2027 Start)` (killed on the token
"manager") and `Staff Software Engineer - AI Research Infrastructure`.

## Combined effect

| | before | after |
|---|---|---|
| model calls per 2,008 listings | ~2,007 | 356 |
| per-call latency | 7.41 s | 3.61 s |
| **classify pass wall time** | **~4.1 hours** | **~21 minutes** |

≈ **11.5× end to end**, of which ~5.6× is the reject-router and ~2× is the model swap.

## First real disagreement, 14B vs 7B (2026-08-08, n=1)

The first end-to-end pipeline run produced exactly one keep: **"Data Analyst" @ 1stdibs.com,
typed `new_grad`**. The posting says *"Experience: 2+ years in data or product analytics"*, so
it is not early-career and `CLASSIFY_SYSTEM` should have returned a null type ("Use null for
senior / experienced ... prefer null when unsure").

Same prompt, same corrected plain text, temperature 0:

| model | verdict | correct? |
|---|---|---|
| `qwen2.5:7b-instruct` | `cs_relevant: true, opportunity_type: "new_grad"` | ✗ false keep |
| `qwen2.5:14b-instruct` | `cs_relevant: false, opportunity_type: null` | ✓ rejects |

Also checked and ruled out: the HTML-decode bug below was NOT the cause — 7B returns
`new_grad` on both the markup-polluted and the corrected text.

### Follow-up (2026-08-09): the same failure mode, 3 more times

A `--limit 5` run produced 3 keeps total. Each was checked against its posting's stated
experience requirement:

| listing | stated requirement | 7B verdict | correct? |
|---|---|---|---|
| Junior Engineer @ 2K | "0–3 years (excellent fresh graduates are welcome)" | `new_grad` | ✓ |
| Researcher @ 2K | "2+ years of UX or other social science research" | `research` | ✗ false keep |
| Data Analyst @ 1stdibs | "2+ years in data or product analytics" | `new_grad` | ✗ false keep |

**Diagnosed pattern:** 7B anchors on the TITLE ("Junior", "Researcher", "Analyst") and
under-weights the explicit experience line in the body. `CLASSIFY_SYSTEM`'s "prefer null when
unsure" is not overriding that title prior. Two candidate fixes with very different costs — a
larger model that weighs the body, or a prompt that names the failure explicitly ("a stated
minimum of 2+ years means NOT early-career, regardless of title"). The prompt change is free
to test and does not touch the Decision 13 model choice. UNDECIDED.

Note these 3 were classified on markup-polluted text (run predates the normalize fix below),
so a clean re-run is needed before treating the rate as real.

**Small n. This is a pattern, not an accuracy rate** — it is the concrete form of the risk
Decision 13 recorded ("7B is weaker on exactly the ambiguous titles that reach it"), and it
raises the priority of the agreement test below rather than settling it.

Worth noting the asymmetry it lands on: a false KEEP is visible and reversible (it shows up
in the product, and the row can be deleted), whereas a false REJECT is invisible and
permanent. 7B erring toward keeps is the less dangerous direction of the two.

## Bug found on the first real run (2026-08-08): entity-decode ordering

`normalizeGreenhouse` passed Greenhouse's entity-ENCODED `content` straight to
`htmlToPlain()`, which strips tags FIRST and decodes entities LAST. Nothing matched, so the
tags were decoded INTO the output instead of removed — `description_plain` was stored as
literal `<div>`/`<a href>` markup.

Impact: the classifier read markup instead of prose, and the text was **22% longer** than it
should have been on a real posting (5,892 → 4,608 chars). That compounds with the
prefill-bound finding above — 68% of postings hit `MAX_DESC_CHARS`, so the markup padding was
truncating real job requirements off the end of the prompt.

Fixed by decoding once in `normalizeGreenhouse` and deriving both fields from the decoded
HTML. Pinned by `src/sources/greenhouse/normalize.test.ts`.

## Real-world throughput, measured from an actual run (2026-08-10)

Benchmarks used full 6000-char prompts. Real postings are shorter, and the entity-decode fix
cut ~22% of the text — and since the workload is prefill-bound, shorter prompts are directly
faster. From the 99-board run's own timestamps:

```
crawl finished  00:11:25
persist landed  00:51:50     -> 2,425 s of filter + extract
model calls     ~1,180 (1,109 model-rejects + ~37 model keeps + 38 extract)
```

**~2.05 s per call in production, versus 3.61 s on the synthetic benchmark.** Use the 2.05
figure for planning; the benchmark number is a worst case.

| scope | wall time (M4 Pro, 7B) |
|---|---|
| 99 boards (measured) | 40 min |
| all 163 boards (extrapolated at ~11.6 model calls/board) | **~65 min** |

A full crawl of every board is now about an hour. The original 4.1-hour figure was fixed by
the reject-router and experience filter (~78% of model calls removed), not by hardware.

## Hardware upgrade analysis (M5 Max / 128 GB) — 2026-08-22

Reasoning, not measurement; exact M5 Max GPU/bandwidth specs unverified, so no multipliers are
claimed. Rerun `bench2.mjs` on any new machine before trusting an estimate.

- **RAM is the meaningful change.** 128 GB removes the model-size ceiling. The 14B needs
  9.5 GB and pushed the 24 GB machine into swap; on 128 GB it is unremarkable, and 32B or a
  quantized 70B (~40 GB) become viable. This matters because 7B has a DOCUMENTED accuracy
  problem the 14B does not (see the disagreement section above) — the upgrade makes Decision
  13's model choice freely reversible.
- **GPU scales prefill.** The workload is ~86% prefill, which is FLOP-bound, so it tracks GPU
  compute. Max-tier chips carry roughly double the GPU cores of Pro-tier, plus generational
  gain. Expect improvement; verify rather than assume.
- **Parallelism is possibly the largest win and is currently disabled BY DESIGN.**
  `filter.ts` processes sequentially, justified as "a single local Ollama instance serves one
  request at a time (and risks OOM on a big model)". The OOM half of that rationale does not
  survive 128 GB — Ollama supports concurrent requests via `OLLAMA_NUM_PARALLEL`. Changing
  this is a pipeline-concurrency/architecture question, i.e. GATED. UNDECIDED.

**Framing: the upgrade converts a speed surplus into accuracy, rather than unblocking
anything.** The pipeline is not currently machine-constrained. It does NOT address the real
open problems: internship supply (2 CS internships in 5,105 postings), the 42% duplicate rate,
the gig-work scope question, or the AIFT anomaly — all in `first-clean-run-audit.md`.

## Not measured

- **Real accuracy comparison, 14B vs 7B.** The natural experiment is agreement rate on the
  356 real listings that survive the routers, with 14B outputs as the baseline. Six matching
  synthetic probes and one real disagreement are not an accuracy rate. This is the main open
  question on the model swap, and is now the highest-value measurement outstanding.
- **3B.** Not pulled; would be a further ~2× if 7B accuracy proves acceptable.
- **Truncation sweep on real postings** (latency + verdict change vs the 6000-char
  baseline) — scripted but not run. 68% of postings hit the ceiling, so this is the largest
  remaining untaken lever (Decision 13 option B).
- **Seasonal validity of the router rates.** Sampled in early August with 3 internship
  titles in 2,008. Re-run in September.
