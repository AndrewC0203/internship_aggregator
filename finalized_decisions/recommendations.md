# Recommendations (resume + questionnaire) — finalized spec

Settled result of **DECISIONS.md Decisions 29–32** (rationale + options live there; this doc
is the build target — point back, don't duplicate). Decision 29: local Ollama embeddings.
Decision 30: pgvector, exact search, no ANN index. Decision 31: symmetric distillation with
an evaluation gate. Decision 32: attainability = alignment chip + curated selectivity badge.
Eval results will live in `research/embedding-model-bakeoff.md` (written when the gate runs).

Architecture in one sentence: **facts filter (SQL), vectors rank (pgvector cosine), labels
inform (deterministic chips)** — three signals, three mechanisms, none doing another's job.
Model calls happen only at write time (ingest enrichment, profile edits); the query path is
pure math and works with Ollama down.

## Schema (one migration)

Enable `pgvector`. `listings` gains:

- `signature Json?` — distilled role signature (schema below)
- `signature_fingerprint String?` — hash over (signature prompt version + the exact prompt
  input tuple: title, company, descriptionPlain, opportunityType, csField). Written only
  when a generated signature is successfully saved. NULL-safe comparisons everywhere
  (`IS DISTINCT FROM`).
- `embedding vector?` — dimension-less on purpose: no ANN index means no fixed-dim
  requirement (Decision 30), so the embedding model stays swappable without migration.
  Prisma: `Unsupported("vector")`; similarity via `$queryRaw`.
- `embedding_model String?`, `template_version Int?` — the config that produced the stored
  vector. A vector is USABLE only if both match current config; enforced in the ranking
  query, never assumed.

New `user_profile` table, single row (`id` fixed = 1):

- `resume_text`, `extracted_profile Json` (model-written), `profile Json` (human-approved —
  the ONLY column downstream reads), `questionnaire Json?`
- `embedding vector?`, `embedding_model`, `template_version`
- `revision Int` — optimistic-concurrency guard (see Consistency)
- `updated_at`

Ownership split mirrors `applications`: model writes `extracted_profile`, human owns
`profile`.

## Role signature (shared shape)

```
{ skills: string[],     // technical only, canonicalized via alias map — soft skills banned
  domains: CsField[],   // listing side: [csField] (single, per Decision 16);
                        // profile side: multiple target fields allowed
  level: string,        // listing: opportunityType; profile: target level(s)
  focus: string }       // one sentence of technical focus; no company/benefits/boilerplate
```

Canonical embed text is a deterministic sectioned template — sections keep "has" and
"wants" from blurring (an ML *interest* must not read as ML *experience*):

- Profile:  `Experience: <demonstrated skills + technical experience, resume-evidenced only>`
            `Seeking: <target levels, target fields, desired work — includes soft questionnaire answers>`
- Listing:  `Role: <level, domain, focus>`  `Requires: <skills>`

Skills sorted alphabetically; alias map (e.g. postgres→postgresql) applied before both
embedding and overlap explanations. Matched-skills explanations read demonstrated skills
only. Embedding models' documented task prefixes (nomic `search_document:`/`search_query:`,
mxbai query prompt) are part of the template and versioned by `template_version`.

## Enrichment stage (signature + embedding)

One code path for backfill and incremental refresh: an enrichment pass over the DB that
processes stale rows, called at the end of `refresh` (non-fatal — a failed enrichment never
blocks ingest; the listing stays in ordinary search) and runnable standalone
(`npm run enrich`). Staleness is fingerprint-driven, which makes the pass naturally
resumable and crash-safe (fingerprints are written only on successful save):

- Regenerate SIGNATURE when `signature_fingerprint IS DISTINCT FROM` the hash computed from
  current inputs + prompt version. (Content edits, prompt bumps, and never-processed rows
  all land here.)
- Regenerate EMBEDDING when `embedding IS NULL` OR `embedding_model` / `template_version`
  `IS DISTINCT FROM` current config. (An embedding-model swap re-embeds WITHOUT re-running
  distillation — the expensive 7B pass is not repeated for a cheap embed-model change.)
- CRASH-WINDOW RULE: saving a changed signature CLEARS the row's embedding (+
  `embedding_model`, `template_version`) in the same write. Otherwise a signature-save
  followed by an embed failure leaves an old embedding that still matches current config —
  eligible for ranking and never retried. With the clear, `embedding IS NULL` is the
  retry trigger and the usability gate excludes the row until re-embedded.

Distillation is a SEPARATE stage/prompt from `extract` (7B, own prompt): extract is
quote-first fact copying with measured accuracy; distillation is abstractive. Mixing them
risks the validated extract contract. Accepted cost: one extra 7B call per listing.

## Evaluation gate (runs BEFORE full backfill)

The 7B distillation pass and the embedding model must both EARN their place, measured, on a
sample — full backfill only after this gate.

0. Prerequisite: an approved profile. The full editing UI comes later in the build order,
   so the gate uses a manually authored + reviewed profile/questionnaire fixture (same
   JSON shape the UI will produce) — evaluation never runs against an unapproved profile.
1. Stratified sample ~200 listings (csField × opportunityType); generate signatures.
2. Pooled labeling: user labels the UNION of top-K results from every approach below
   (relevant / borderline / irrelevant vs the approved profile) — pooling, so no approach's
   top-10 contains unjudged items. A held-out slice of judgments is reserved for a final
   check AFTER model + freshness weight are chosen (repeated tuning against one label set
   overfits it).
3. Approaches compared:
   (a) signature embeddings, per candidate model, with documented task prefixes;
   (b) title + cleaned descriptionPlain embedding, truncation strategy documented — the
       honest no-distillation baseline (full description, not just title/company/csField);
   (c) deterministic skill-overlap + field match, no embeddings (tests whether embeddings
       add value beyond extracted skills — note it shares the signature model's skills).
4. Metrics, pre-registered: Precision@10 with borderline counting as NOT relevant (primary;
   borderline-inclusive reported secondary); field clustering as diagnostic only (csField
   leaks into signature text — clustering CANNOT be the selection metric); soft-preference
   responsiveness (adding "prefer swe" must measurably promote SWE listings); freshness
   weight sanity on the labeled set.
5. Winner + numbers → `research/embedding-model-bakeoff.md`. If baseline (b) wins, ship it
   and amend Decision 31.

## User profile flow

Pasted plain text v1 (PDF parsing deferred). Extraction: 14B, quote-grounded (Decision 24
pattern) — may only claim what it can point to in the resume. UI shows the extracted
profile; user edits; approval publishes `profile` + its embedding together (see
Consistency). Nothing downstream reads unapproved content. Strength rubric: DEFERRED to v2
(drives nothing once probability banding was cut — see Decision 32).

## Questionnaire

| Question | Kind |
|---|---|
| Grad year window | Hard (overlap with gradYear cols; nulls kept + badged) |
| US citizen? / currently work-authorized? / need sponsorship now or later? | Hard — three separate booleans, mapping below |
| Locations + remote OK | Hard (array overlap; remote still applies country filter when locCountries present; unresolved kept + badged) |
| Opportunity types wanted | Hard multi-select |
| Target fields | Soft by default; per-field must-have toggle promotes to hard; multiple must-haves = OR |
| Free-text interests | Soft |

Soft answers merge into the profile's `Seeking:` section before embedding (one mechanism,
no weight knobs). Soft edits trigger re-embed; hard edits don't (they're SQL only).

Work-auth exclusion mapping (three inputs, not one conflated status):

- listing `us_citizen_required` → excluded unless citizen = yes
- listing `no_sponsorship` → excluded if needs-sponsorship (now or later) = yes — current
  authorization alone is not enough (OPT case: authorized now, needs sponsorship later)
- `sponsorship_available` / `unknown` → never excluded; unknown renders an
  "eligibility unverified" badge — unknown must look different from confirmed-eligible

Every hard filter keeps nulls and badges them; filters exclude only explicit contradictions.

## Ranking

One `$queryRaw`: hard filters + `is_listed` + `embedding IS NOT NULL AND embedding_model =
$cfg AND template_version = $cfg` (the usability gate — `signature IS NOT NULL` is NOT
sufficient, signature can succeed while embedding fails), returning ALL eligible rows with
cosine distance — no candidate truncation (top-K-by-similarity before blending can evict
fresh-but-close listings; at ≤1,832 rows the full set is measured-trivial). Node then:

- `score = W_SIM * similarity + W_FRESH * freshness` (named constants, start 0.85/0.15;
  freshness = exp decay on publishedAt fallback firstSeenAt, ~30-day half-life; weight
  validated on the labeled set — the blend can reorder, that must be a chosen behavior)
- Node sorts by (score desc, id asc) and paginates — deterministic ordering for a fixed
  dataset and scoring time; pagination can still shift as freshness decays or listings
  change between requests.
- Deadlines displayed with urgency, never scored (too sparse).
- UI shows qualitative bands only; cosine is never rendered as a percentage.

Determinism claim, precisely: no model calls at query time; scores drift with time by
design (freshness).

## Labels (Decision 32)

- Alignment chip from extracted facts (YOE, degreeStatus), facts shown. Wording:
  "No gaps found in checked requirements" / "Stated gaps: <facts>" / "Eligibility
  unverified" — never "meets requirements" (we only check what we extract).
- Selectivity badge from hand-curated `data/company-tiers.json`, only famously-selective
  employers. Wording: "Highly selective employer — manually curated", with a note in the
  UI explaining how entries are chosen. Unlisted = NOT ASSESSED, never "less selective".
  No probability claims anywhere; badge annotates, never filters. "Hide reaches" toggle
  dropped with the banding; a plain filter-by-badge toggle may come later if wanted.

## Consistency rules

- Profile publish uses optimistic concurrency: read `revision` → generate embedding
  (OUTSIDE any transaction — model calls never hold a txn open) → transaction:
  `UPDATE ... WHERE revision = read_revision`, bump revision; 0 rows updated = a newer edit
  won, surface conflict, never overwrite. Approved inputs + matching embedding always land
  together.
- Ranking hard-errors (loud, not silent) if the profile embedding is null OR its
  `embedding_model` / `template_version` disagree with current config → "re-embed profile"
  remediation. (Same two-field gate as listings — a template bump must not compare
  new-template listing vectors against an old-template profile vector.)
- Listings excluded by the usability gate surface as a visible count in the UI — a
  half-enriched corpus degrades loudly.
- Ollama down: browse/rank unaffected; profile edits and enrichment fail with 503 +
  "start `ollama serve`".

## API + UI

`POST /api/profile/resume` (extract) · `GET/PUT /api/profile` (edit/approve → publish) ·
`PUT /api/profile/questionnaire` · `GET /api/recommendations`. UI in the existing
server-rendered style: profile/setup page + "For You" view — score band, matched
demonstrated skills, alignment chip, selectivity badge where assessed, deadline urgency,
unverified-eligibility badges. No approved profile → setup CTA, not an error.

## Testing

Unit: canonical-text determinism (fixed inputs → byte-identical), fingerprint staleness
matrix (each trigger fires independently; NULL-safe), blend math + stable sort, work-auth
mapping table, questionnaire→SQL mapping, signature schema validation on fixtures, alias
canonicalization. No live model calls in tests (repo pattern). Ranking quality is covered
by the evaluation gate, not unit tests; skipped: end-to-end UI tests.

## Build order

1. Migration (pgvector + columns + user_profile)
2. `embed()` in src/model/ollama.ts (+ retry reuse)
3. Signature stage + enrichment pass (sample mode) + approved profile fixture
4. **Evaluation gate** → research doc → GO/AMEND decision
5. Full enrichment backfill (background)
6. Profile flow (extract, edit UI, publish)
7. Questionnaire + ranking endpoint
8. For You UI + labels
9. Walkthroughs (scoring, enrichment), FEATURES.md, README commands
   (new prerequisites: `ollama pull <embed model>`; new scripts: `enrich`, eval script)
