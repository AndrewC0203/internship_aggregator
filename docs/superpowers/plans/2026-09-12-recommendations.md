# Recommendations (resume + questionnaire) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 3 recommender: pgvector-ranked "For You" listings against an approved resume profile + questionnaire, gated by a labeled evaluation before full backfill.

**Architecture:** Facts filter (SQL), vectors rank (pgvector cosine), labels inform (deterministic chips). Model calls happen only at write time (a 7B distillation pass per listing, a 14B resume extraction, Ollama embeddings); the query path is pure math and works with Ollama down. One enrichment pass (fingerprint-driven, resumable) serves both backfill and incremental refresh.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), Fastify 5, Prisma 6 + PostgreSQL 14 + pgvector (exact search, no ANN index), Ollama (qwen2.5:7b distill, qwen2.5:14b resume extract, nomic-embed-text / mxbai-embed-large candidates), node:test.

**Spec:** `finalized_decisions/recommendations.md` (settles DECISIONS.md Decisions 29–32 — read both before executing).

## Global Constraints

- Local DB: `postgresql://achoi@localhost:5432/internship_aggregator`, Homebrew postgresql@14.18. **pgvector is NOT installed** — Task 1 builds it from source (brew's formula only targets pg 17/18). 1,948 active / 2,338 total listings today.
- Ollama 0.33.3 at `http://localhost:11434`; `qwen2.5:7b-instruct` + `qwen2.5:14b-instruct` pulled; embed models are NOT pulled yet (Task 2 pulls them).
- Tests: `npm test` = `tsx --test "src/**/*.test.ts"`, node:test + `assert/strict`. **No live model or DB calls in tests** (repo rule). Test pure functions; DB/model paths get smoke-tested by running the real commands.
- Prisma cannot read/write `Unsupported("vector")` columns — all vector I/O via `$queryRaw`/`$executeRaw` (Decision 30).
- Vectors are USABLE only when `embedding IS NOT NULL AND embedding_model = current AND template_version = current` — enforced in every ranking query, never assumed. `signature IS NOT NULL` is NOT sufficient.
- Crash-window rule: saving a changed signature CLEARS embedding + embedding_model + template_version **in the same SQL statement**.
- All NULL comparisons in staleness logic are `IS DISTINCT FROM`-style (null-safe).
- Model prompts follow classifier.ts patterns: JSON-schema-constrained output, abstain-to-null, boundary validation of everything the model returns.
- Commit style: short lowercase summaries (`git log` shows "dedup fully implemented" etc.).
- The eval gate (Task 13) needs ~30–45 min of USER labeling — everything else must not block on it. Full backfill (Task 14) runs only after the gate.

## File Structure

```
src/model/ollama.ts            MODIFY  add embed() — batch embeddings via /api/embed, retry reuse
src/model/signature.ts         CREATE  7B distillation prompt + distill() + signature assembly
src/model/profile-extract.ts   CREATE  14B quote-grounded resume extraction
src/recommend/config.ts        CREATE  EMBED_MODEL, TEMPLATE_VERSION, SIGNATURE_PROMPT_VERSION, weights
src/recommend/aliases.ts       CREATE  skill alias map + canonicalizeSkills()
src/recommend/canonical.ts     CREATE  canonical embed text (listing/profile/baseline) + fingerprint
src/recommend/enrich.ts        CREATE  enrichment pass (staleness-driven signature + embed)
src/recommend/questionnaire.ts CREATE  questionnaire types + work-auth mapping + hard-filter SQL conditions
src/recommend/score.ts         CREATE  freshness decay + blend + stable sort + bands
src/recommend/rank.ts          CREATE  the one ranking $queryRaw + assembly (matched skills, chips)
src/recommend/profile.ts       CREATE  profile publish (optimistic concurrency) + profile load for ranking
src/recommend/labels.ts        CREATE  alignment chip + selectivity badge
src/recommend/__fixtures__/profile.fixture.json  CREATE  approved-profile fixture for the eval gate
src/enrich.ts                  CREATE  CLI wrapper (npm run enrich)
src/eval-recommend.ts          CREATE  eval gate CLI: sample / pool / score
src/refresh.ts                 MODIFY  call enrichment at end, non-fatal
src/server/recommend.ts        CREATE  API routes (profile, questionnaire, recommendations)
src/server/render-profile.ts   CREATE  /profile SSR page
src/server/render-foryou.ts    CREATE  /foryou SSR page
src/server/render.ts           MODIFY  export css() + small shared helpers for the new pages
src/server/index.ts            MODIFY  register routes + pages
prisma/schema.prisma           MODIFY  pgvector columns + user_profile
data/company-tiers.json        CREATE  curated selectivity list
package.json                   MODIFY  enrich + eval:recommend scripts
README.md / FEATURES.md        MODIFY  commands, prerequisites, feature entry
```

Execution order note: Tasks 1–12 are buildable without the user. Task 13 (eval pool) ends in a USER LABELING handoff; Tasks 8–12 can proceed while labels are pending. Task 14 (score + bakeoff doc + GO/AMEND + backfill) runs after labels arrive.

---

### Task 1: pgvector + migration (listings columns, user_profile)

**Files:**
- Modify: `prisma/schema.prisma` (Listing additions + UserProfile model)
- Create: `prisma/migrations/<ts>_add_recommendations/migration.sql` (via `--create-only`, then edited)

**Interfaces:**
- Produces: `listings.signature Json?`, `listings.signature_fingerprint String?`, `listings.embedding vector?`, `listings.embedding_model String?`, `listings.template_version Int?`; `user_profile` table (single row id=1, `revision` guard). Later tasks read/write vector columns ONLY via raw SQL.

- [ ] **Step 1: Build pgvector from source against postgresql@14**

brew's pgvector formula builds only against postgresql@17/18 (checked 2026-09-12), so source-build against the running 14.18. `/opt/homebrew` is user-writable — no sudo.

```bash
git clone --branch v0.8.6 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector-build
cd /tmp/pgvector-build
make PG_CONFIG=/opt/homebrew/opt/postgresql@14/bin/pg_config
make install PG_CONFIG=/opt/homebrew/opt/postgresql@14/bin/pg_config
psql "postgresql://achoi@localhost:5432/internship_aggregator" \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name='vector';"
```
Expected: one row, `vector | 0.8.6`. (Do NOT `CREATE EXTENSION` here — the migration owns that, so a fresh DB rebuilds from migrations alone.)

- [ ] **Step 2: Add schema**

Append to the `Listing` model (after `duplicateKeys`):

```prisma
  // Recommendations (Decisions 29-32; spec: finalized_decisions/recommendations.md).
  // signature: distilled role signature (skills/domains/level/focus). Fingerprint is the
  // staleness key — written ONLY on a successful signature save, so a crash mid-enrich
  // leaves the row stale and it is retried (resumability comes from this, not job state).
  signature            Json?
  signatureFingerprint String? @map("signature_fingerprint")
  // Dimension-less vector on purpose: no ANN index means no fixed-dim requirement
  // (Decision 30), so the embed model stays swappable without a migration. Prisma cannot
  // read/write this type — all vector I/O is $queryRaw/$executeRaw.
  embedding            Unsupported("vector")?
  // The config that produced the stored vector. A vector is usable only if BOTH match
  // current config — enforced in the ranking query, never assumed.
  embeddingModel       String? @map("embedding_model")
  templateVersion      Int?    @map("template_version")
```

New model (ownership split mirrors `applications`: model writes extracted_profile, human owns profile — nothing downstream reads unapproved content):

```prisma
model UserProfile {
  id               Int      @id @default(1) // single row, fixed id
  resumeText       String?  @map("resume_text")
  extractedProfile Json?    @map("extracted_profile") // model-written, never read downstream
  profile          Json?    // human-approved — the ONLY column ranking reads
  questionnaire    Json?
  embedding        Unsupported("vector")?
  embeddingModel   String?  @map("embedding_model")
  templateVersion  Int?     @map("template_version")
  revision         Int      @default(0) // optimistic-concurrency guard for publish
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("user_profile")
}
```

- [ ] **Step 3: Create migration without applying, prepend extension**

```bash
npx prisma migrate dev --create-only --name add_recommendations
```
Edit the generated `migration.sql`: add as FIRST line:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 4: Apply + verify**

```bash
npx prisma migrate dev
psql "postgresql://achoi@localhost:5432/internship_aggregator" -c "\d listings" -c "\d user_profile"
npm test
```
Expected: both tables show the new columns (`embedding | vector`), all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add prisma/ && git commit -m "recommendations: pgvector migration (listings vector cols + user_profile)"
```

---

### Task 2: `embed()` in src/model/ollama.ts

**Files:**
- Modify: `src/model/ollama.ts`
- Test: `src/model/ollama.test.ts` (extend)

**Interfaces:**
- Produces: `embed(texts: string[], model: string): Promise<number[][]>` — batch embeddings, wrapped in the existing `withOllamaRetry`, throwing `OllamaError` with the same transient/fatal classification as `chatJson`. Also `toVectorLiteral(v: number[]): string` → `"[0.1,0.2,...]"` for pgvector casts.

- [ ] **Step 1: Pull the embed models (env prerequisite, both bakeoff candidates)**

```bash
ollama pull nomic-embed-text && ollama pull mxbai-embed-large
```

- [ ] **Step 2: Write failing tests**

Append to `src/model/ollama.test.ts`:

```ts
import { toVectorLiteral, parseEmbedResponse } from "./ollama.js";

test("toVectorLiteral renders a pgvector-castable literal", () => {
  assert.equal(toVectorLiteral([0.1, -2, 3e-7]), "[0.1,-2,3e-7]");
});

test("parseEmbedResponse: shape-validates embeddings against input count", () => {
  assert.deepEqual(parseEmbedResponse({ embeddings: [[1, 2]] }, 1), [[1, 2]]);
  // count mismatch, missing field, ragged/empty vectors are all fatal (not OllamaError)
  assert.throws(() => parseEmbedResponse({ embeddings: [[1]] }, 2), /expected 2/);
  assert.throws(() => parseEmbedResponse({}, 1), /no embeddings/);
  assert.throws(() => parseEmbedResponse({ embeddings: [[]] }, 1), /empty/);
});
```

- [ ] **Step 3: Run to verify failure** — `npm test` → FAIL (exports missing).

- [ ] **Step 4: Implement**

In `src/model/ollama.ts`:

```ts
// pgvector literal: '[v1,v2,...]' — used by every $queryRaw/$executeRaw vector param.
export const toVectorLiteral = (v: number[]): string => `[${v.join(",")}]`;

// Boundary validation, exported for tests. A shape violation is a real bug (wrong model
// tag, wrong Ollama version) — plain Error, so withOllamaRetry treats it as fatal.
export function parseEmbedResponse(body: unknown, expected: number): number[][] {
  const embeddings = (body as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings)) throw new Error("Ollama returned no embeddings array");
  if (embeddings.length !== expected)
    throw new Error(`Ollama returned ${embeddings.length} embeddings, expected ${expected}`);
  for (const e of embeddings) {
    if (!Array.isArray(e) || e.length === 0) throw new Error("Ollama returned an empty embedding");
  }
  return embeddings as number[][];
}

// Batch embedding via /api/embed ({model, input: string[]} -> {embeddings}). Same
// timeout/abort/OllamaError seam as chatJsonOnce, same retry wrapper.
export async function embed(texts: string[], model: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  return withOllamaRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        throw new OllamaError(`Ollama embed timed out after ${TIMEOUT_MS}ms (model "${model}")`);
      throw new OllamaError(`Ollama network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new OllamaError(`Ollama ${res.status}: ${await res.text()}`, res.status);
    return parseEmbedResponse(await res.json(), texts.length);
  });
}
```

- [ ] **Step 5: Run tests** — `npm test` → PASS. Live smoke (not a test):
```bash
npx tsx -e "import {embed} from './src/model/ollama.js'; embed(['hello'],'nomic-embed-text').then(v=>console.log(v[0].length))"
```
Expected: `768`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "recommendations: embed() batch client + vector literal"`

---

### Task 3: config, alias map, canonical text, fingerprint

**Files:**
- Create: `src/recommend/config.ts`, `src/recommend/aliases.ts`, `src/recommend/canonical.ts`
- Test: `src/recommend/canonical.test.ts`, `src/recommend/aliases.test.ts`

**Interfaces:**
- Produces:
  - config: `EMBED_MODEL` (env `OLLAMA_EMBED_MODEL` ?? `"nomic-embed-text"`), `TEMPLATE_VERSION = 1`, `SIGNATURE_PROMPT_VERSION = 1`, `W_SIM = 0.85`, `W_FRESH = 0.15`, `FRESHNESS_HALF_LIFE_DAYS = 30`
  - aliases: `canonicalizeSkills(raw: string[]): string[]` — lowercase, trim, alias-map, dedup, sort
  - canonical: `RoleSignature { skills: string[]; domains: string[]; level: string; focus: string }`, `validateSignature(raw: unknown): RoleSignature | null`, `signatureFingerprint(i: FingerprintInput): string`, `listingCanonicalText(sig, model)`, `profileCanonicalText(profile, questionnaire, model)`, `baselineCanonicalText(title, descriptionPlain, model)`, `FingerprintInput { title; company; descriptionPlain; opportunityType: string | null; csField: string | null }`

- [ ] **Step 1: Write failing tests**

`src/recommend/aliases.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeSkills } from "./aliases.js";

test("canonicalizeSkills: lowercases, aliases, dedups, sorts", () => {
  assert.deepEqual(
    canonicalizeSkills(["Postgres", "TS", "typescript", "  React.js ", "golang"]),
    ["go", "postgresql", "react", "typescript"],
  );
});
test("canonicalizeSkills: drops empties, keeps unknown skills verbatim (lowercased)", () => {
  assert.deepEqual(canonicalizeSkills(["", "  ", "Zig"]), ["zig"]);
});
```

`src/recommend/canonical.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSignature, signatureFingerprint, listingCanonicalText,
  profileCanonicalText, baselineCanonicalText,
} from "./canonical.js";

const SIG = { skills: ["python", "pytorch"], domains: ["ml_ai"], level: "internship",
  focus: "Trains and evaluates ML models for ranking." };

test("listing canonical text is deterministic and sectioned (nomic prefixes)", () => {
  const a = listingCanonicalText(SIG, "nomic-embed-text");
  // byte-identical on repeat call — determinism is the invariant embeddings depend on
  assert.equal(a, listingCanonicalText({ ...SIG }, "nomic-embed-text"));
  assert.equal(a,
    "search_document: Role: internship ml_ai — Trains and evaluates ML models for ranking.\nRequires: python, pytorch");
});

test("mxbai: document side has NO prefix; query side has the documented prompt", () => {
  assert.ok(!listingCanonicalText(SIG, "mxbai-embed-large").startsWith("search_document:"));
  const q = profileCanonicalText(
    { skills: ["python"], focus: "Built data pipelines." },
    { types: ["internship"], targetFields: [{ field: "swe", mustHave: false }], interests: "" },
    "mxbai-embed-large");
  assert.ok(q.startsWith("Represent this sentence for searching relevant passages: "));
});

test("profile text keeps Experience (has) and Seeking (wants) in separate sections", () => {
  const t = profileCanonicalText(
    { skills: ["java"], focus: "Backend services in Java." },
    { types: ["internship"], targetFields: [{ field: "ml_ai", mustHave: false }],
      interests: "interested in ML" },
    "nomic-embed-text");
  const [expLine, seekLine] = t.replace("search_query: ", "").split("\n");
  // an ML *interest* must never read as ML *experience*
  assert.ok(expLine.startsWith("Experience:") && !expLine.includes("ML"));
  assert.ok(seekLine.startsWith("Seeking:") && seekLine.includes("ml_ai") && seekLine.includes("interested in ML"));
});

test("baseline text: title + truncated description, documented cap", () => {
  const t = baselineCanonicalText("SWE Intern", "x".repeat(7000), "nomic-embed-text");
  assert.ok(t.startsWith("search_document: SWE Intern\n"));
  assert.ok(t.length <= "search_document: SWE Intern\n".length + 6000);
});

test("fingerprint staleness matrix: each input flips it independently; null-safe", () => {
  const base = { title: "t", company: "c", descriptionPlain: "d",
    opportunityType: "internship", csField: "swe" };
  const fp = signatureFingerprint(base);
  assert.equal(fp, signatureFingerprint({ ...base })); // stable
  for (const change of [
    { title: "t2" }, { company: "c2" }, { descriptionPlain: "d2" },
    { opportunityType: null }, { csField: null }, { csField: "ml_ai" },
  ] as const) {
    assert.notEqual(signatureFingerprint({ ...base, ...change }), fp);
  }
  // null vs null compares equal (IS NOT DISTINCT FROM semantics)
  assert.equal(
    signatureFingerprint({ ...base, csField: null }),
    signatureFingerprint({ ...base, csField: null }));
});

test("validateSignature: accepts the shape, rejects junk", () => {
  assert.deepEqual(validateSignature(SIG), SIG);
  assert.equal(validateSignature(null), null);
  assert.equal(validateSignature({ ...SIG, skills: "python" }), null);
  assert.equal(validateSignature({ ...SIG, focus: "" }), null);
  assert.equal(validateSignature({ ...SIG, skills: Array(25).fill("x") }), null); // cap 20
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/recommend/config.ts`:
```ts
// Recommendation config (Decisions 29-31). These two values ARE the vector-usability gate:
// a stored embedding is used only when its row's embedding_model + template_version match.
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
export const TEMPLATE_VERSION = 1;
// Version of the distillation prompt — part of the signature fingerprint, so bumping it
// marks every signature stale (and the enrichment pass regenerates them).
export const SIGNATURE_PROMPT_VERSION = 1;
// Blend weights + decay (spec: start 0.85/0.15, ~30-day half-life; validated at the eval gate).
export const W_SIM = 0.85;
export const W_FRESH = 0.15;
export const FRESHNESS_HALF_LIFE_DAYS = 30;
```

`src/recommend/aliases.ts`:
```ts
// Skill alias map — applied before BOTH embedding and overlap explanations so "postgres"
// on the resume matches "PostgreSQL" in a posting. Key: lowercase surface form; value:
// canonical form. Small and curated on purpose; unknown skills pass through lowercased.
const ALIASES: Record<string, string> = {
  postgres: "postgresql", "postgre sql": "postgresql", js: "javascript", ts: "typescript",
  golang: "go", "react.js": "react", reactjs: "react", "node.js": "node", nodejs: "node",
  "vue.js": "vue", k8s: "kubernetes", tf: "tensorflow", sklearn: "scikit-learn",
  "scikit learn": "scikit-learn", np: "numpy", gcp: "google cloud", amazon: "aws",
  "amazon web services": "aws", "c sharp": "c#", "objective c": "objective-c",
  "ci/cd": "cicd", "ci-cd": "cicd",
};

export function canonicalizeSkills(raw: string[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const s = r.trim().toLowerCase();
    if (!s) continue;
    out.add(ALIASES[s] ?? s);
  }
  return [...out].sort();
}
```

`src/recommend/canonical.ts`:
```ts
import { createHash } from "node:crypto";
import { SIGNATURE_PROMPT_VERSION } from "./config.js";
import { canonicalizeSkills } from "./aliases.js";

// Shared role-signature shape (spec "Role signature"). Listing side: domains=[csField],
// level=opportunityType (deterministic copies — the model only produces skills+focus).
export interface RoleSignature {
  skills: string[];
  domains: string[];
  level: string;
  focus: string;
}

const MAX_SKILLS = 20;
const MAX_FOCUS = 300;

// Boundary validation (same seam as classifier.ts): a signature that fails shape checks is
// treated as a failed distillation — not saved, so the fingerprint stays stale and it retries.
export function validateSignature(raw: unknown): RoleSignature | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const strArr = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!strArr(o.skills) || o.skills.length === 0 || o.skills.length > MAX_SKILLS) return null;
  if (!strArr(o.domains)) return null;
  if (typeof o.level !== "string" || !o.level) return null;
  if (typeof o.focus !== "string" || !o.focus.trim() || o.focus.length > MAX_FOCUS) return null;
  return { skills: o.skills, domains: o.domains, level: o.level, focus: o.focus };
}

// Staleness key: prompt version + the exact prompt input tuple. JSON.stringify of a fixed
// array is order-stable; nulls serialize distinctly from any string, giving null-safe
// comparison for free.
export interface FingerprintInput {
  title: string; company: string; descriptionPlain: string;
  opportunityType: string | null; csField: string | null;
}
export function signatureFingerprint(i: FingerprintInput): string {
  return createHash("sha256")
    .update(JSON.stringify([SIGNATURE_PROMPT_VERSION, i.title, i.company, i.descriptionPlain,
      i.opportunityType, i.csField]))
    .digest("hex");
}

// Documented task prefixes are PART of the template (versioned by TEMPLATE_VERSION):
// nomic wants search_document:/search_query:; mxbai prompts only the query side.
const docPrefix = (model: string): string => model.startsWith("nomic") ? "search_document: " : "";
const queryPrefix = (model: string): string =>
  model.startsWith("nomic") ? "search_query: "
  : model.startsWith("mxbai") ? "Represent this sentence for searching relevant passages: "
  : "";

// Listing side: sectioned so requirements read as requirements.
export function listingCanonicalText(sig: RoleSignature, model: string): string {
  const skills = canonicalizeSkills(sig.skills).join(", ");
  return `${docPrefix(model)}Role: ${sig.level} ${sig.domains.join(", ")} — ${sig.focus.trim()}\nRequires: ${skills}`;
}

// Profile side. Experience = resume-evidenced only; Seeking = questionnaire wants (levels,
// fields, free-text interests). Sections keep "has" and "wants" from blurring.
export interface ProfileJson { skills: string[]; focus: string }
export interface QuestionnaireSoft {
  types: string[];
  targetFields: Array<{ field: string; mustHave: boolean }>;
  interests: string;
}
export function profileCanonicalText(
  p: ProfileJson, q: QuestionnaireSoft, model: string,
): string {
  const skills = canonicalizeSkills(p.skills).join(", ");
  const fields = q.targetFields.map((f) => f.field).join(", ");
  const seek = [
    q.types.length ? `${q.types.join(", ")} roles` : "early-career roles",
    fields ? `in ${fields}` : "",
    q.interests.trim() ? `— ${q.interests.trim()}` : "",
  ].filter(Boolean).join(" ");
  return `${queryPrefix(model)}Experience: ${p.focus.trim()} Skills: ${skills}.\nSeeking: ${seek}`;
}

// Baseline (b) for the eval gate: honest no-distillation text. Truncation documented: first
// 6000 chars of descriptionPlain (same cap the classifier prompts use — MAX_DESC_CHARS).
export const BASELINE_DESC_CAP = 6000;
export function baselineCanonicalText(title: string, descriptionPlain: string, model: string): string {
  return `${docPrefix(model)}${title}\n${descriptionPlain.slice(0, BASELINE_DESC_CAP)}`;
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "recommendations: canonical text, fingerprint, alias map, config"`

---

### Task 4: signature distillation stage (7B)

**Files:**
- Create: `src/model/signature.ts`
- Test: `src/model/signature.test.ts`

**Interfaces:**
- Consumes: `chatJson`, `passModel`-style env precedence, `validateSignature`, `canonicalizeSkills`.
- Produces: `distill(input: DistillInput): Promise<RoleSignature>` where `DistillInput { title; company; descriptionPlain; opportunityType: string | null; csField: string | null }`; throws on model failure or invalid shape (caller treats as failed distillation). Also `assembleSignature(modelOut, input)` (pure, exported for tests).

- [ ] **Step 1: Write failing tests**

`src/model/signature.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSignature, distillModel } from "./signature.js";

const IN = { title: "ML Intern", company: "Acme", descriptionPlain: "d",
  opportunityType: "internship", csField: "ml_ai" };

test("assembleSignature: domains/level are deterministic copies, skills canonicalized", () => {
  const sig = assembleSignature({ skills: ["PyTorch", "Postgres"], focus: "Trains models." }, IN);
  assert.deepEqual(sig, { skills: ["postgresql", "pytorch"], domains: ["ml_ai"],
    level: "internship", focus: "Trains models." });
});

test("assembleSignature: null csField -> empty domains; null type -> 'unknown' level", () => {
  const sig = assembleSignature({ skills: ["go"], focus: "f" },
    { ...IN, opportunityType: null, csField: null });
  assert.deepEqual(sig?.domains, []);
  assert.equal(sig?.level, "unknown");
});

test("assembleSignature: junk model output -> null (soft-skill/empty guards)", () => {
  assert.equal(assembleSignature({ skills: [], focus: "f" }, IN), null);
  assert.equal(assembleSignature({ skills: ["go"], focus: "" }, IN), null);
});

test("distillModel: per-pass env > global > 7b default", () => {
  assert.equal(distillModel({}), "qwen2.5:7b-instruct");
  assert.equal(distillModel({ OLLAMA_MODEL: "x" }), "x");
  assert.equal(distillModel({ OLLAMA_MODEL: "x", OLLAMA_DISTILL_MODEL: "y" }), "y");
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/model/signature.ts` — mirror classifier.ts structure:

```ts
import { chatJson } from "./ollama.js";
import { validateSignature, type RoleSignature } from "../recommend/canonical.js";
import { canonicalizeSkills } from "../recommend/aliases.js";

// Distillation (Decision 31): a SEPARATE stage/prompt from extract — extract is quote-first
// fact copying with measured accuracy; this is abstractive. Mixing them risks the validated
// extract contract. Accepted cost: one extra 7B call per listing.

export function distillModel(env: Record<string, string | undefined> = process.env): string {
  return env.OLLAMA_DISTILL_MODEL ?? env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
}

const DISTILL_SCHEMA = {
  type: "object",
  properties: {
    skills: { type: "array", items: { type: "string" }, maxItems: 12 },
    focus: { type: "string" },
  },
  required: ["skills", "focus"],
} as const;

const DISTILL_SYSTEM = `You distill a job posting into a role signature for matching against candidate resumes.

Return:
- skills: the TECHNICAL skills, tools, languages, and frameworks the role requires or prefers (e.g. "python", "react", "kubernetes"). NEVER include soft skills (communication, teamwork, leadership, passion), degrees, GPAs, or years of experience. Lowercase. At most 12.
- focus: ONE sentence describing the role's technical focus — what the person will build or work on. No company name, no benefits, no equal-opportunity boilerplate, no soft skills.`;

const MAX_DESC_CHARS = 6000;

export interface DistillInput {
  title: string; company: string; descriptionPlain: string;
  opportunityType: string | null; csField: string | null;
}

// Pure assembly + validation, exported for tests. domains/level are deterministic copies of
// stored classification (Decision 16 single csField) — the model is only trusted for
// skills+focus, and even those pass validateSignature before anything is saved.
export function assembleSignature(
  out: { skills: string[]; focus: string }, input: DistillInput,
): RoleSignature | null {
  return validateSignature({
    skills: canonicalizeSkills(out.skills),
    domains: input.csField ? [input.csField] : [],
    level: input.opportunityType ?? "unknown",
    focus: out.focus.trim(),
  });
}

export async function distill(input: DistillInput): Promise<RoleSignature> {
  const user = [
    `Title: ${input.title}`, `Company: ${input.company}`, "",
    "Description:", input.descriptionPlain.slice(0, MAX_DESC_CHARS),
  ].join("\n");
  const out = await chatJson<{ skills: string[]; focus: string }>({
    system: DISTILL_SYSTEM, user, schema: DISTILL_SCHEMA, model: distillModel(),
  });
  const sig = assembleSignature(out, input);
  if (!sig) throw new Error("distillation produced an invalid signature");
  return sig;
}
```

- [ ] **Step 4: Run tests** — PASS. Live smoke on one real listing via tsx one-liner (pick any active row).
- [ ] **Step 5: Commit** — `git commit -am "recommendations: 7B signature distillation stage"`

---

### Task 5: enrichment pass + CLI + refresh hook

**Files:**
- Create: `src/recommend/enrich.ts`, `src/enrich.ts`
- Modify: `src/refresh.ts` (call at end, non-fatal), `package.json` (script `"enrich": "tsx src/enrich.ts"`)
- Test: `src/recommend/enrich.test.ts`

**Interfaces:**
- Consumes: `distill`, `embed`, `toVectorLiteral`, `signatureFingerprint`, `listingCanonicalText`, `EMBED_MODEL`, `TEMPLATE_VERSION`.
- Produces: `enrichListings(opts?: { ids?: number[]; limit?: number }): Promise<EnrichSummary>` where `EnrichSummary { signatureRegen: number; signatureFailed: number; embedded: number; embedFailed: number; upToDate: number }`. Pure helper `needsSignature(row: { signatureFingerprint: string | null }, currentFp: string): boolean`.

**Behavior (the spec's crash-window rule, verbatim into code):**
1. Signature pass: rows where stored fingerprint ≠ computed fingerprint (null-safe). For each: `distill()`, then ONE statement:
   `UPDATE listings SET signature=$1::jsonb, signature_fingerprint=$2, embedding=NULL, embedding_model=NULL, template_version=NULL WHERE id=$3` — the same-write clear means a later embed failure leaves `embedding IS NULL` (the retry trigger), never a stale-but-config-matching vector.
2. Embed pass: rows where `signature IS NOT NULL AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $EMBED_MODEL OR template_version IS DISTINCT FROM $TEMPLATE_VERSION)`. Batch 16 texts per `embed()` call; per-batch failure isolation (log, skip — rows stay NULL and retry next pass). Save: `UPDATE listings SET embedding=$1::vector, embedding_model=$2, template_version=$3 WHERE id=$4`.
3. Scope: active listings only (`is_listed`), `ids`/`limit` subset support (eval + smoke). Sequential distill (one local model), progress logs before each model call (repo rule: silence reads as hung).

- [ ] **Step 1: Write failing test** (pure part)

`src/recommend/enrich.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsSignature, embedBatches } from "./enrich.js";

test("needsSignature: null stored fingerprint is stale; equal is fresh (null-safe)", () => {
  assert.equal(needsSignature({ signatureFingerprint: null }, "abc"), true);
  assert.equal(needsSignature({ signatureFingerprint: "old" }, "abc"), true);
  assert.equal(needsSignature({ signatureFingerprint: "abc" }, "abc"), false);
});

test("embedBatches: splits into stable batches of 16", () => {
  const items = Array.from({ length: 35 }, (_, i) => i);
  const b = embedBatches(items, 16);
  assert.deepEqual(b.map((x) => x.length), [16, 16, 3]);
  assert.deepEqual(b.flat(), items);
});
```

- [ ] **Step 2: Verify failure. Step 3: Implement** per behavior above (reclassify.ts is the pattern for the loop/logging/error isolation; `enrichListings` lives in src/recommend/enrich.ts and takes no CLI concerns).

`src/enrich.ts` CLI (mirrors reclassify.ts arg parsing):
```
npm run enrich -- [--limit N]
```
prints the EnrichSummary. `src/refresh.ts` after `runPipeline(...)`:
```ts
// Enrichment (Decisions 29-31): non-fatal by contract — a failed enrichment never blocks
// ingest; the listing stays in ordinary search and the next pass retries it.
try {
  const summary = await enrichListings();
  console.log(`[enrich] signatures ${summary.signatureRegen} (+${summary.signatureFailed} failed), ` +
    `embedded ${summary.embedded} (+${summary.embedFailed} failed), ${summary.upToDate} up-to-date.`);
} catch (err) {
  console.error(`[enrich] pass failed (ingest unaffected): ${err instanceof Error ? err.message : err}`);
}
```

- [ ] **Step 4: Tests pass; smoke `npm run enrich -- --limit 3` writes 3 signatures+embeddings (verify via psql: `SELECT id, embedding_model, template_version, embedding IS NULL FROM listings WHERE signature IS NOT NULL LIMIT 5;`).**
- [ ] **Step 5: Commit** — `"recommendations: fingerprint-driven enrichment pass + enrich CLI + refresh hook"`

---

### Task 6: questionnaire types + hard-filter mapping

**Files:**
- Create: `src/recommend/questionnaire.ts`
- Test: `src/recommend/questionnaire.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Questionnaire {
    gradYearMin: number | null; gradYearMax: number | null;
    usCitizen: boolean | null; workAuthorized: boolean | null; needsSponsorship: boolean | null;
    locStates: string[]; locCountries: string[]; remoteOk: boolean;
    types: string[];
    targetFields: Array<{ field: string; mustHave: boolean }>;
    interests: string;
  }
  parseQuestionnaire(raw: unknown): Questionnaire          // boundary validation, defaults
  workAuthExclusions(q): { excludeCitizenRequired: boolean; excludeNoSponsorship: boolean }
  hardConditions(q): Prisma.Sql[]                           // AND-ed into the ranking query
  ```

- [ ] **Step 1: Write failing tests** — the work-auth mapping table is THE test (spec's three-boolean mapping):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { workAuthExclusions, hardConditions, parseQuestionnaire, defaultQuestionnaire } from "./questionnaire.js";

const q = (over: object) => ({ ...defaultQuestionnaire(), ...over });

test("work-auth mapping: citizen sees everything", () => {
  assert.deepEqual(workAuthExclusions(q({ usCitizen: true, needsSponsorship: false })),
    { excludeCitizenRequired: false, excludeNoSponsorship: false });
});
test("work-auth: non-citizen excludes us_citizen_required", () => {
  assert.equal(workAuthExclusions(q({ usCitizen: false })).excludeCitizenRequired, true);
});
test("work-auth: OPT case — authorized NOW but needs sponsorship LATER still excludes no_sponsorship", () => {
  const e = workAuthExclusions(q({ usCitizen: false, workAuthorized: true, needsSponsorship: true }));
  assert.equal(e.excludeNoSponsorship, true);
});
test("work-auth: unanswered (nulls) excludes NOTHING — filters act only on explicit contradictions", () => {
  assert.deepEqual(workAuthExclusions(q({})),
    { excludeCitizenRequired: false, excludeNoSponsorship: false });
});
test("hardConditions: empty questionnaire -> no conditions (browse-everything default)", () => {
  assert.equal(hardConditions(q({})).length, 0);
});
test("hardConditions: each answered facet contributes exactly one condition", () => {
  assert.equal(hardConditions(q({ gradYearMin: 2027, gradYearMax: 2028 })).length, 1);
  assert.equal(hardConditions(q({ types: ["internship"] })).length, 1);
  assert.equal(hardConditions(q({ targetFields: [{ field: "swe", mustHave: true }] })).length, 1);
  assert.equal(hardConditions(q({ locStates: ["NY"] })).length, 1);
});
test("parseQuestionnaire: junk fields dropped, unknown enum values dropped", () => {
  const p = parseQuestionnaire({ types: ["internship", "ceo"], locStates: ["ny"], gradYearMin: "x" });
  assert.deepEqual(p.types, ["internship"]);
  assert.deepEqual(p.locStates, ["NY"]);
  assert.equal(p.gradYearMin, null);
});
```

- [ ] **Step 2: Verify failure. Step 3: Implement.**

Key SQL fragments (every hard filter keeps nulls — filters exclude only explicit contradictions; badge rendering handles the nulls):

```ts
import { Prisma } from "@prisma/client";

export function hardConditions(q: Questionnaire): Prisma.Sql[] {
  const conds: Prisma.Sql[] = [];
  const ex = workAuthExclusions(q);
  const excluded: string[] = [];
  if (ex.excludeCitizenRequired) excluded.push("us_citizen_required");
  if (ex.excludeNoSponsorship) excluded.push("no_sponsorship");
  if (excluded.length)
    conds.push(Prisma.sql`(citizenship_status IS NULL OR citizenship_status NOT IN (${Prisma.join(excluded)})::"CitizenshipStatus"[])`);
    // NOTE: enum-array casting is finicky — implementer may use = ANY / <> ALL with ::text
    // comparison instead: (citizenship_status IS NULL OR citizenship_status::text <> ALL(${excluded}))
  if (q.gradYearMin !== null && q.gradYearMax !== null)
    conds.push(Prisma.sql`(grad_year_min IS NULL OR grad_year_min <= ${q.gradYearMax}) AND (grad_year_max IS NULL OR grad_year_max >= ${q.gradYearMin})`);
  if (q.types.length)
    conds.push(Prisma.sql`(opportunity_type IS NULL OR opportunity_type::text = ANY(${q.types}))`);
  const musts = q.targetFields.filter((f) => f.mustHave).map((f) => f.field);
  if (musts.length)
    conds.push(Prisma.sql`(cs_field IS NULL OR cs_field::text = ANY(${musts}))`); // multiple must-haves = OR
  if (q.locStates.length || q.locCountries.length) {
    // Location: match on facet arrays; unresolved (both arrays empty) kept + badged.
    // Remote passes ONLY under the country rule: a remote listing with stated countries
    // must overlap the user's countries (user countries ∪ US-implied-by-states).
    const userCountries = [...new Set([...q.locCountries, ...(q.locStates.length ? ["US"] : [])])];
    conds.push(Prisma.sql`(
      (loc_us_states = '{}' AND loc_countries = '{}')
      OR loc_us_states && ${q.locStates}
      OR loc_countries && ${q.locCountries.length ? q.locCountries : userCountries}
      OR (${q.remoteOk} AND workplace_type = 'remote'
          AND (loc_countries = '{}' OR loc_countries && ${userCountries}))
    )`);
  }
  return conds;
}
```

(Exact array-binding syntax to be settled against Prisma at execution — `${array}` binds as a Postgres array in $queryRaw; verify with a live query in the smoke step. The TEST asserts condition COUNT + the pure workAuthExclusions table, not SQL text.)

- [ ] **Step 4: Tests pass. Step 5: Commit** — `"recommendations: questionnaire types + work-auth mapping + hard filters"`

---

### Task 7: scoring (freshness, blend, sort, bands)

**Files:**
- Create: `src/recommend/score.ts`
- Test: `src/recommend/score.test.ts`

**Interfaces:**
- Produces: `freshness(publishedAt: Date | null, firstSeenAt: Date, now?: Date): number` (exp decay, half-life 30d, publishedAt fallback firstSeenAt); `blendScore(similarity: number, fresh: number): number` (`W_SIM*sim + W_FRESH*fresh`); `sortRecs<T extends {score: number; id: number}>(rows: T[]): T[]` (score desc, id asc — deterministic); `band(score: number): "strong" | "good" | "fair"` with PROVISIONAL thresholds (0.60/0.45) as named constants, calibrated at the eval gate (Task 14).

- [ ] **Step 1: Failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshness, blendScore, sortRecs, band } from "./score.js";

const D = (s: string) => new Date(s);

test("freshness: 1.0 at age 0, 0.5 at one half-life, monotone decay", () => {
  const now = D("2026-09-12T00:00:00Z");
  assert.ok(Math.abs(freshness(now, now, now) - 1) < 1e-9);
  assert.ok(Math.abs(freshness(D("2026-08-13T00:00:00Z"), now, now) - 0.5) < 0.01); // 30 days
  assert.ok(freshness(D("2026-06-01Z"), now, now) < freshness(D("2026-09-01Z"), now, now));
});
test("freshness: publishedAt null falls back to firstSeenAt", () => {
  const now = D("2026-09-12T00:00:00Z");
  assert.equal(freshness(null, now, now), freshness(now, now, now));
});
test("blend: 0.85/0.15 named-constant math", () => {
  assert.ok(Math.abs(blendScore(1, 0) - 0.85) < 1e-9);
  assert.ok(Math.abs(blendScore(0, 1) - 0.15) < 1e-9);
});
test("sort: score desc, id asc tiebreak — deterministic pagination", () => {
  const rows = [{ id: 2, score: 0.5 }, { id: 1, score: 0.5 }, { id: 3, score: 0.9 }];
  assert.deepEqual(sortRecs(rows).map((r) => r.id), [3, 1, 2]);
});
test("bands are qualitative only", () => {
  assert.equal(band(0.7), "strong");
  assert.equal(band(0.5), "good");
  assert.equal(band(0.2), "fair");
});
```

- [ ] **Step 2–4: fail → implement → pass.** Implementation is ~20 lines using config constants; freshness: `Math.exp(-Math.LN2 * ageDays / FRESHNESS_HALF_LIFE_DAYS)` with `ageDays = max(0, (now - (publishedAt ?? firstSeenAt)) / 86_400_000)`.
- [ ] **Step 5: Commit** — `"recommendations: freshness decay + blend + deterministic sort"`

---

### Task 8: labels — alignment chip + selectivity badge

**Files:**
- Create: `src/recommend/labels.ts`, `data/company-tiers.json`
- Test: `src/recommend/labels.test.ts`

**Interfaces:**
- Consumes: `minYearsExperience(descriptionPlain)` from `src/pipeline/stages/experience.ts` (verify exact export name/signature before use — it exists per Decision 14).
- Produces:
  ```ts
  type ChipState = "clear" | "gaps" | "unverified";
  interface AlignmentChip { state: ChipState; facts: string[] }   // facts shown, never hidden
  alignmentChip(l: ChipInput, q: Questionnaire): AlignmentChip
  selectivityBadge(company: string): string | null   // fixed wording or null = NOT ASSESSED
  ```
- Chip mapping (only checked facts; wording per Decision 32 — never "meets requirements"):
  - gap when: stated min YOE > 0 (`"states N+ years experience"`); user grad window entirely outside listing window (both sides non-null); `degreeStatus === "completed_required"` (`"requires a completed degree"`); work-auth contradiction (listing `us_citizen_required` and `q.usCitizen === false`, or `no_sponsorship` and `q.needsSponsorship === true`) — these can appear even though ranking filters them, because the chip logic must stand alone for search-page reuse.
  - `clear` when at least one fact was checkable and none contradicted → copy "No gaps found in checked requirements".
  - `unverified` when NOTHING was checkable (all inputs null) → "Eligibility unverified".
- `data/company-tiers.json` shape:
  ```json
  { "note": "Hand-curated: employers famously selective for early-career roles. Inclusion criteria: household-name tech/quant firms with publicly reported single-digit intern acceptance rates or equivalent reputation. Unlisted companies are NOT ASSESSED — never 'less selective'.",
    "companies": ["Google", "Meta", "Apple", "Microsoft", "Amazon", "Netflix", "NVIDIA", "OpenAI", "Anthropic", "Stripe", "Databricks", "Palantir", "SpaceX", "Jane Street", "Citadel", "Citadel Securities", "Two Sigma", "Hudson River Trading", "Jump Trading", "D. E. Shaw", "Optiver", "IMC Trading"] }
  ```
  Lookup: case-insensitive trimmed match. Badge wording fixed: `"Highly selective employer — manually curated"`.

- [ ] **Step 1: Failing tests** — mapping table incl.: unlisted company → `null`; YOE 0 / null → no gap; all-null inputs → unverified; contradiction lists the FACT string.
- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `"recommendations: alignment chip + curated selectivity badge (Decision 32)"`

---

### Task 9: profile extraction (14B, quote-grounded) + publish flow

**Files:**
- Create: `src/model/profile-extract.ts`, `src/recommend/profile.ts`
- Test: `src/model/profile-extract.test.ts`, `src/recommend/profile.test.ts`

**Interfaces:**
- profile-extract produces: `extractProfile(resumeText: string): Promise<ExtractedProfile>` where `ExtractedProfile { skills: string[]; focus: string; dropped: string[] }`. Schema (evidence-first, Decision 24 pattern): model returns `{ skills: [{ name, evidence }], focus: { text, evidence } }`; pure `groundClaims(out, resumeText)` (exported for tests) DROPS any claim whose evidence is not a real substring of the resume (whitespace-normalized, case-insensitive) — may only claim what it can point to.
- profile.ts produces:
  ```ts
  publishProfile(prisma, args: { profile: ProfileJson; questionnaire: Questionnaire; expectedRevision: number }):
    Promise<{ ok: true } | { ok: false; conflict: true }>
  loadRankingProfile(prisma): Promise<
    | { state: "ready"; profile: ProfileJson; questionnaire: Questionnaire; vector: number[] }
    | { state: "no_profile" }            // -> setup CTA, not an error
    | { state: "stale_embedding" }>      // -> hard error + "re-embed profile" remediation
  ```
- Publish algorithm (consistency rules, verbatim from spec): read row → build `profileCanonicalText` → `embed()` OUTSIDE any transaction → single guarded statement:
  `UPDATE user_profile SET profile=$1::jsonb, questionnaire=$2::jsonb, embedding=$3::vector, embedding_model=$4, template_version=$5, revision=revision+1, updated_at=now() WHERE id=1 AND revision=$6` → rowCount 0 = a newer edit won → surface conflict, never overwrite. Approved inputs + matching embedding always land together.
- Questionnaire-only saves: recompute canonical text; if text unchanged vs current profile+questionnaire (hard-field-only edit) → plain jsonb update, NO re-embed; if changed (soft edit) → full publish path. The rule is "re-embed iff canonical text changed" — deterministic, no field taxonomy.

- [ ] **Step 1: Failing tests** — `groundClaims`: fabricated-evidence claim dropped + listed in `dropped`; whitespace/case-normalized match kept; `focus` with bad evidence → falls back to skills-only focus? NO — focus with unverifiable evidence is dropped and `extractProfile` throws (a profile without focus is not publishable; caller surfaces "extraction failed, edit manually"). Test the softEditRequiresReembed(before, after) helper: interests change → true; gradYear change → false.
- [ ] **Step 2–4: fail → implement → pass.** 14B via env precedence `OLLAMA_PROFILE_MODEL ?? OLLAMA_MODEL ?? "qwen2.5:14b-instruct"`.
- [ ] **Step 5: Commit** — `"recommendations: quote-grounded resume extraction + optimistic-concurrency publish"`

---

### Task 10: ranking query + assembly

**Files:**
- Create: `src/recommend/rank.ts`
- Test: `src/recommend/rank.test.ts` (pure assembly parts)

**Interfaces:**
- Consumes: `loadRankingProfile`, `hardConditions`, score.ts fns, labels.ts, `toVectorLiteral`, config.
- Produces:
  ```ts
  recommend(prisma, opts: { page?: number; per?: number }): Promise<
    | { state: "no_profile" } | { state: "stale_embedding" }
    | { state: "ready"; total: number; excludedUnenriched: number; page: number; per: number;
        items: RecItem[] }>
  interface RecItem { id; company; title; url; location; opportunityType; csField;
    score: number; band: "strong"|"good"|"fair"; matchedSkills: string[];
    chip: AlignmentChip; selectivity: string | null;
    applicationDeadline: Date | null; deadlineDaysLeft: number | null;
    citizenshipUnverified: boolean; locationUnresolved: boolean }
  ```
- ONE `$queryRaw` (no candidate truncation — ALL eligible rows come back with distance; ≤2k rows is measured-trivial):
  ```sql
  SELECT id, company, title, url, location, opportunity_type, cs_field, citizenship_status,
         degree_status, grad_year_min, grad_year_max, loc_countries, loc_us_states,
         application_deadline, published_at, first_seen_at, description_plain, signature,
         1 - (embedding <=> $vec::vector) AS similarity
  FROM listings
  WHERE is_listed
    AND embedding IS NOT NULL AND embedding_model = $m AND template_version = $v
    AND <hardConditions AND-joined>
  ```
  plus a second count query with the usability gate INVERTED (`NOT (embedding IS NOT NULL AND ...)`) under the same hard filters + is_listed → `excludedUnenriched` (a half-enriched corpus degrades loudly — the UI must show this).
- Node then: `score = blendScore(similarity, freshness(...))`, `sortRecs`, paginate, `matchedSkills = profile.skills ∩ signature.skills` (both already canonical; DEMONSTRATED skills only — never questionnaire interests), chip + badge per row. Cosine never rendered as a percentage anywhere.

- [ ] **Step 1: Failing tests** for the pure assembly: `matchedSkills` intersection; pagination math; excluded-count passthrough. (The SQL itself is smoke-tested live in Task 12's walkthrough — vector ops can't run in unit tests.)
- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `"recommendations: ranking query (usability gate, no truncation) + blend assembly"`

---

### Task 11: API routes

**Files:**
- Create: `src/server/recommend.ts` — `registerRecommendRoutes(app: FastifyInstance): void`
- Modify: `src/server/index.ts` (one `registerRecommendRoutes(app)` call)

**Routes (all follow the applications-route error style — 400 bad input, JSON bodies):**
- `POST /api/profile/resume` `{ resumeText: string }` → upsert user_profile row (id=1) with resume_text; run `extractProfile`; save extracted_profile (model-written column ONLY); 503 + `{ error: "ollama_down", hint: "start \`ollama serve\`" }` on OllamaError with no status/5xx; returns `{ extracted, dropped }`.
- `GET /api/profile` → `{ resumeText, extractedProfile, profile, questionnaire, revision, embedding: { model, templateVersion, current: boolean } | null }`.
- `PUT /api/profile` `{ profile: ProfileJson, questionnaire: Questionnaire, revision: number }` → validate shapes (canonicalizeSkills on the way in), `publishProfile`; 409 `{ error: "revision_conflict" }` on conflict; 503 ollama-down.
- `PUT /api/profile/questionnaire` `{ questionnaire, revision }` → hard-only edit path (no re-embed) unless canonical text changed (then full publish path); same 409/503 contract.
- `GET /api/recommendations?page=&per=` → `recommend()`; `no_profile` → 200 `{ needsSetup: true }` (setup CTA, not an error); `stale_embedding` → 409 `{ error: "profile_embedding_stale", remediation: "re-approve profile to re-embed (PUT /api/profile)" }`.

- [ ] **Step 1: implement routes (thin — all logic lives in recommend/ modules already tested).**
- [ ] **Step 2: Smoke with curl against `npm run serve`** (profile fixture as body; verify 409 by sending a stale revision; verify recommendations return with sample-enriched rows).
- [ ] **Step 3: Commit** — `"recommendations: profile/questionnaire/recommendations API"`

---

### Task 12: UI — /profile setup page + /foryou view

**Files:**
- Create: `src/server/render-profile.ts`, `src/server/render-foryou.ts`
- Modify: `src/server/render.ts` (export `css()` and `esc()`; add a "FOR YOU" nav link near the ticker), `src/server/index.ts` (GET /profile, GET /foryou)

**Content (existing terminal-board SSR style — no SPA, inline JS fetch like `setControl`):**
- `/profile`: resume textarea + "EXTRACT" button (POST, then reload showing extracted skills as editable comma-list + focus textarea); questionnaire form (grad-year window selects, three work-auth yes/no/unanswered radio groups, states/countries text inputs, remote checkbox, type checkboxes, target-field rows with per-field MUST-HAVE toggle, interests textarea); "APPROVE & PUBLISH" button → PUT with revision; conflict → inline "newer edit exists — reload". Extracted vs approved shown as distinct sections (ownership split visible).
- `/foryou`: if `needsSetup` → CTA card linking /profile. Else: header line `N matches · M listings not yet enriched (excluded)`; one row per RecItem: band chip (STRONG MATCH / GOOD MATCH / FURTHER — qualitative only, never a percentage), company/title/url/location, matched demonstrated skills (`matchedSkills.join(", ")`), alignment chip (state + facts), selectivity badge when assessed, deadline urgency (`CLOSES IN Nd` when ≤14d), "eligibility unverified" + "location unresolved" badges where applicable; pagination links.

- [ ] **Step 1: implement both pages. Step 2: visual smoke via `npm run serve` + browser/curl. Step 3: Commit** — `"recommendations: profile + for-you SSR pages"`

---

### Task 13: eval gate tooling + profile fixture + POOL RUN (ends in user handoff)

**Files:**
- Create: `src/eval-recommend.ts`, `src/recommend/__fixtures__/profile.fixture.json`
- Modify: `package.json` (`"eval:recommend": "tsx src/eval-recommend.ts"`)
- Test: `src/recommend/eval-metrics.test.ts` (pure metric fns — put `precisionAtK`, `stratifiedSample`, `poolTopK` in `src/recommend/eval-metrics.ts`)

**Interfaces / subcommands:**
- `npm run eval:recommend -- sample` → stratified ~200 ids over (csField × opportunityType) cells, proportional allocation (ceil, min 1 per non-empty cell, deterministic: id asc within cell) → `research/embedding-eval/sample.json`.
- `npm run eval:recommend -- pool` → for the sample: ensure signatures (shared `enrichListings({ids})`); embed FIVE approaches in memory: sig×nomic, sig×mxbai, baseline×nomic, baseline×mxbai (profile side: signature-style canonical text vs raw resume+questionnaire text, truncation cap documented) + deterministic skill-overlap scorer (|profile.skills ∩ sig.skills| + field-match bonus, no embeddings); rank each; write `research/embedding-eval/rankings.json` + labeling sheet `research/embedding-eval/labels.csv` (union of every approach's top-10; columns `id,company,title,url,label` with label blank; `relevant` / `borderline` / `irrelevant`). ALSO persists default-config embeddings for the sample rows (so /foryou demos pre-backfill).
- `npm run eval:recommend -- score` → reads labels.csv (rejects blanks); holds out every 5th labeled row (deterministic) from selection; reports per approach: P@10 borderline-exclusive (PRIMARY), P@10 borderline-inclusive (secondary); field-clustering mean intra/inter csField cosine (DIAGNOSTIC ONLY — csField leaks into signature text, clustering cannot select); soft-preference responsiveness (re-embed profile with `interests += " prefer software engineering roles"` → SWE count delta in top-20 must be ≥ 0 and visibly positive for the winner); freshness-weight sanity on the labeled set (top-10 with W_FRESH 0 vs 0.15 — list any label-irrelevant item the blend promotes INTO top-10); final held-out check for the chosen config. Prints a results block to paste into `research/embedding-model-bakeoff.md`.
- Fixture: same JSON shape the UI produces — `{ "profile": { "skills": [...], "focus": "..." }, "questionnaire": { ...Questionnaire } }`. DRAFTED by the executor, but **the user must edit it to describe THEMSELVES and approve it before labeling** — evaluation never runs against an unapproved profile (spec prerequisite 0). Loaded by `pool`/`score` via `--fixture` flag defaulting to the fixture path; also loadable into user_profile via `PUT /api/profile` for the live demo.

- [ ] **Step 1: Failing tests** — `precisionAtK` (borderline both modes), `stratifiedSample` allocation (respects 200 cap, min-1 per cell, deterministic), `poolTopK` union/dedup.
- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: run `sample` + `pool` for real** (needs Ollama; ~200 distill calls ≈ 20–40 min on the 7B — run in background). Verify labels.csv has every approach's top-10 covered (pooling invariant: no approach's top-10 contains unjudged items).
- [ ] **Step 6: Commit** — `"recommendations: eval gate tooling (sample/pool/score) + profile fixture"`
- [ ] **Step 7: HANDOFF — user labels `research/embedding-eval/labels.csv` (~30–45 min) after fixing the fixture to be their real profile.** Tasks 8–12 can be built while waiting; Task 14 cannot.

---

### Task 14 (POST-LABELS): score, bakeoff doc, GO/AMEND, full backfill

- [ ] Run `npm run eval:recommend -- score`; write `research/embedding-model-bakeoff.md` (winner + all pre-registered numbers + held-out check + chosen freshness weight + band-threshold calibration from labeled scores).
- [ ] Decision point: if a signature approach wins → set `EMBED_MODEL` default to the winner, keep design, log nothing new (Decision 31 stands). If baseline (b) wins → ship baseline (swap `listingCanonicalText` call in enrich to `baselineCanonicalText`, bump TEMPLATE_VERSION) and AMEND Decision 31 in DECISIONS.md.
- [ ] Update `band()` thresholds from labeled score distribution; note in score.ts comment.
- [ ] Full backfill: `npm run enrich` (background; ~1,950 distill calls ≈ 3–5 h on 7B + minutes of embedding). Verify: usability-gate count on /foryou drops to ~0.
- [ ] Commit + update README metrics line if the dup/enrichment posture line changes.

---

### Task 15: docs + walkthroughs (same turn as feature completion, per CLAUDE.md)

- [ ] README "Commands": `npm run enrich` (+ `--limit`), `npm run eval:recommend -- sample|pool|score`, new prerequisites: `ollama pull nomic-embed-text`, `ollama pull mxbai-embed-large`, pgvector source-build note for postgresql@14.
- [ ] FEATURES.md: feature bullets + "Decisions to remember" (crash-window clear rule; usability gate is two-field; profile publish revision guard; labels never filter).
- [ ] Remind user: README architecture diagram needs a "recommendations" lane (user maintains diagrams).
- [ ] WALKTHROUGH-REQUIRED writeups (in the final report, ~5–10 lines each): the scoring/ranking logic and the enrichment/staleness design (invariant, failure mode, rejected alternative).
- [ ] Commit — `"recommendations: docs + commands"`

## Self-Review Checklist (run after writing, before executing)

- Spec coverage: schema ✓(T1) embed ✓(T2) canonical/fingerprint ✓(T3) distill ✓(T4) enrichment+crash-window ✓(T5) questionnaire/work-auth ✓(T6) scoring ✓(T7) labels ✓(T8) profile flow+consistency ✓(T9) ranking+usability gate+excluded count ✓(T10) API ✓(T11) UI ✓(T12) eval gate ✓(T13-14) docs/walkthroughs ✓(T15).
- Known deliberate deviations from skill defaults: executed inline (executing-plans) on a feature branch, not a worktree — the shared dev DB can't be isolated by a worktree anyway, and CLAUDE.md's velocity rules prefer batch-in-place; migration runs against the one real DB.
