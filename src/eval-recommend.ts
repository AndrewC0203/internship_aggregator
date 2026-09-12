import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "./db.js";
import { embed } from "./model/ollama.js";
import { enrichListings, embedBatches } from "./recommend/enrich.js";
import {
  listingCanonicalText,
  profileCanonicalText,
  baselineCanonicalText,
  validateSignature,
  BASELINE_DESC_CAP,
  type ProfileJson,
} from "./recommend/canonical.js";
import { canonicalizeSkills } from "./recommend/aliases.js";
import { parseQuestionnaire, type Questionnaire } from "./recommend/questionnaire.js";
import {
  cosineSim,
  precisionAtK,
  projectRanking,
  stratifiedAllocate,
  poolTopK,
} from "./recommend/eval-metrics.js";
import { freshness, blendScore, sortRecs } from "./recommend/score.js";

// Evaluation gate CLI (Decision 31 amendment; spec "Evaluation gate"). Three subcommands,
// run in order, with the human labeling step between pool and score:
//
//   npm run eval:recommend -- sample   draw the stratified ~200-listing sample
//   npm run eval:recommend -- pool     signatures + embeddings for 5 approaches ->
//                                      rankings + pooled labeling sheet (labels.csv)
//   (YOU label research/embedding-eval/labels.csv: relevant / borderline / irrelevant)
//   npm run eval:recommend -- score    pre-registered metrics + held-out final check
//
// Approaches compared (spec 3a-3c):
//   sig:nomic / sig:mxbai     signature embeddings per candidate model (documented prefixes)
//   raw:nomic / raw:mxbai     title + descriptionPlain (truncated at BASELINE_DESC_CAP) —
//                             the honest no-distillation baseline
//   overlap                   deterministic skill-overlap + field match, no embeddings
//
// All eval artifacts live in research/embedding-eval/ (they back the bakeoff decision);
// vectors.json is regenerable bulk and gitignored.

const EVAL_DIR = "research/embedding-eval";
const FIXTURE_PATH = "src/recommend/__fixtures__/profile.fixture.json";
const MODELS = ["nomic-embed-text", "mxbai-embed-large"] as const;
const K = 10;
const SAMPLE_TARGET = 200;

interface SampleRow {
  id: number;
  company: string;
  title: string;
  url: string;
  publishedAt: string | null;
  firstSeenAt: string;
  csField: string | null;
  opportunityType: string | null;
}

interface Fixture {
  resumeText: string;
  profile: ProfileJson;
  questionnaire: Questionnaire;
}

function loadFixture(): Fixture {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
  const profile = raw.profile as ProfileJson;
  if (!profile?.skills?.length || !profile.focus) {
    throw new Error(`fixture at ${FIXTURE_PATH} is missing profile.skills/focus`);
  }
  if (typeof raw.resumeText !== "string" || raw.resumeText.includes("PLACEHOLDER")) {
    console.warn(
      "\n  WARNING: fixture resumeText still contains PLACEHOLDER — labels judged against it",
    );
    console.warn("  will grade a fake persona. Edit the fixture before labeling.\n");
  }
  return {
    resumeText: String(raw.resumeText ?? ""),
    profile: { skills: canonicalizeSkills(profile.skills), focus: profile.focus },
    questionnaire: parseQuestionnaire(raw.questionnaire),
  };
}

// Baseline (b) profile side: the no-distillation query — raw resume text + the soft
// questionnaire answers, same truncation cap as the listing side, model's query prefix.
function baselineProfileText(f: Fixture, model: string): string {
  const soft = [f.questionnaire.types.join(", "), f.questionnaire.interests]
    .filter(Boolean)
    .join(". ");
  const prefix = model.startsWith("nomic")
    ? "search_query: "
    : model.startsWith("mxbai")
      ? "Represent this sentence for searching relevant passages: "
      : "";
  return `${prefix}${f.resumeText.slice(0, BASELINE_DESC_CAP)}\n${soft}`;
}

// ── sample ────────────────────────────────────────────────────────────────────────────────

async function cmdSample(): Promise<void> {
  const rows = await prisma.listing.findMany({
    where: { isListed: true },
    orderBy: { id: "asc" },
    select: {
      id: true, company: true, title: true, url: true, publishedAt: true,
      firstSeenAt: true, csField: true, opportunityType: true,
    },
  });

  const cellKey = (r: { csField: string | null; opportunityType: string | null }): string =>
    `${r.csField ?? "null"}|${r.opportunityType ?? "null"}`;
  const cells = new Map<string, number>();
  for (const r of rows) cells.set(cellKey(r), (cells.get(cellKey(r)) ?? 0) + 1);

  const alloc = stratifiedAllocate(cells, SAMPLE_TARGET);
  const sample: SampleRow[] = [];
  for (const [key, n] of alloc) {
    // Deterministic draw: id asc within the cell (reproducible without RNG).
    const cellRows = rows.filter((r) => cellKey(r) === key).slice(0, n);
    sample.push(
      ...cellRows.map((r) => ({
        id: r.id, company: r.company, title: r.title, url: r.url,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        firstSeenAt: r.firstSeenAt.toISOString(),
        csField: r.csField, opportunityType: r.opportunityType,
      })),
    );
  }
  sample.sort((a, b) => a.id - b.id);

  mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(join(EVAL_DIR, "sample.json"), JSON.stringify({ target: SAMPLE_TARGET, cells: [...alloc.entries()], sample }, null, 2));
  console.log(`[eval] sample: ${sample.length} listings across ${alloc.size} (csField x type) cells -> ${EVAL_DIR}/sample.json`);
}

// ── pool ──────────────────────────────────────────────────────────────────────────────────

async function cmdPool(): Promise<void> {
  const { sample } = JSON.parse(readFileSync(join(EVAL_DIR, "sample.json"), "utf8")) as {
    sample: SampleRow[];
  };
  const fixture = loadFixture();
  const ids = sample.map((s) => s.id);

  // Signatures (+ default-config embeddings) via the ONE shared enrichment path — this also
  // makes /foryou demoable on the sample before the full backfill.
  console.log(`[eval] ensuring signatures for ${ids.length} sampled listings (7B, sequential)...`);
  const summary = await enrichListings({ ids });
  console.log(`[eval] enrich: ${summary.signatureRegen} signatures regenerated, ${summary.signatureFailed} failed`);

  const rows = await prisma.listing.findMany({
    where: { id: { in: ids } },
    orderBy: { id: "asc" },
    select: { id: true, title: true, descriptionPlain: true, signature: true, csField: true },
  });
  const withSig = rows
    .map((r) => ({ ...r, sig: validateSignature(r.signature) }))
    .filter((r) => {
      if (!r.sig) console.warn(`[eval] #${r.id} has no valid signature after enrich — dropped from pool`);
      return r.sig !== null;
    });

  const rankings: Record<string, number[]> = {};
  const scores: Record<string, Array<{ id: number; score: number }>> = {};
  const vectors: Record<string, Record<string, Record<number, number[]>>> = {};

  for (const model of MODELS) {
    vectors[model] = { sig: {}, raw: {} };
    console.log(`[eval] embedding ${withSig.length} x2 texts with ${model}...`);
    const sigTexts = withSig.map((r) => listingCanonicalText(r.sig!, model));
    const rawTexts = withSig.map((r) => baselineCanonicalText(r.title, r.descriptionPlain, model));
    // Chunked + sequential, like the enrich pass: 200 raw-baseline texts are ~300k tokens —
    // as ONE /api/embed request that can outlive the 120s Ollama timeout, and Ollama
    // serializes on the single model anyway, so concurrency buys nothing here.
    const embedChunked = async (texts: string[]): Promise<number[][]> => {
      const out: number[][] = [];
      for (const batch of embedBatches(texts, 32)) out.push(...(await embed(batch, model)));
      return out;
    };
    const sigVecs = await embedChunked(sigTexts);
    const rawVecs = await embedChunked(rawTexts);
    const [profSig, profRaw] = await embed(
      [profileCanonicalText(fixture.profile, fixture.questionnaire, model), baselineProfileText(fixture, model)],
      model,
    );

    for (const [variant, vecs, prof] of [
      ["sig", sigVecs, profSig],
      ["raw", rawVecs, profRaw],
    ] as const) {
      const approach = `${variant}:${model.split("-")[0]}`;
      const ranked = withSig
        .map((r, i) => {
          vectors[model][variant][r.id] = vecs[i];
          return { id: r.id, score: cosineSim(vecs[i], prof) };
        })
        .sort((a, b) => b.score - a.score || a.id - b.id);
      scores[approach] = ranked;
      rankings[approach] = ranked.map((r) => r.id);
    }
  }

  // Approach (c): deterministic skill-overlap + field match, no embeddings. Shares the
  // signature model's skills by construction (documented tradeoff in Decision 31): this
  // tests whether EMBEDDINGS add value beyond extracted skills, not the whole LLM pipeline.
  const targetFields = new Set(fixture.questionnaire.targetFields.map((f) => f.field));
  const have = new Set(fixture.profile.skills);
  const overlapRanked = withSig
    .map((r) => ({
      id: r.id,
      score:
        r.sig!.skills.filter((s) => have.has(s)).length +
        (r.csField && targetFields.has(r.csField) ? 0.5 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  scores["overlap"] = overlapRanked;
  rankings["overlap"] = overlapRanked.map((r) => r.id);

  const pooled = poolTopK(rankings, K);
  const byId = new Map(sample.map((s) => [s.id, s]));
  const csv = [
    "id,company,title,url,label",
    ...pooled.map((id) => {
      const s = byId.get(id)!;
      const q = (v: string) => `"${v.replaceAll('"', '""')}"`;
      return `${id},${q(s.company)},${q(s.title.trim())},${q(s.url)},`;
    }),
  ].join("\n");

  writeFileSync(join(EVAL_DIR, "rankings.json"), JSON.stringify({ k: K, approaches: Object.keys(rankings), scores }, null, 2));
  writeFileSync(join(EVAL_DIR, "vectors.json"), JSON.stringify(vectors));
  writeFileSync(join(EVAL_DIR, "labels.csv"), csv);
  console.log(`[eval] pooled ${pooled.length} unique listings from ${Object.keys(rankings).length} approaches' top-${K}`);
  console.log(`[eval] -> ${EVAL_DIR}/labels.csv  (fill the last column: relevant / borderline / irrelevant)`);
}

// ── score ─────────────────────────────────────────────────────────────────────────────────

function readLabels(): Map<number, string> {
  const lines = readFileSync(join(EVAL_DIR, "labels.csv"), "utf8").trim().split("\n").slice(1);
  const labels = new Map<number, string>();
  const allowed = new Set(["relevant", "borderline", "irrelevant"]);
  for (const line of lines) {
    const id = Number(line.split(",")[0]);
    const label = line.split(",").at(-1)!.trim().toLowerCase().replaceAll('"', "");
    if (!allowed.has(label)) {
      throw new Error(`labels.csv: row for id ${id} has label "${label}" — every pooled row needs relevant/borderline/irrelevant`);
    }
    labels.set(id, label);
  }
  return labels;
}

async function cmdScore(): Promise<void> {
  const { sample } = JSON.parse(readFileSync(join(EVAL_DIR, "sample.json"), "utf8")) as { sample: SampleRow[] };
  const { scores } = JSON.parse(readFileSync(join(EVAL_DIR, "rankings.json"), "utf8")) as {
    scores: Record<string, Array<{ id: number; score: number }>>;
  };
  const labels = readLabels();
  const fixture = loadFixture();

  // Held-out slice: every 5th labeled id (sorted asc) is reserved for the final check and
  // excluded from every selection metric — repeated tuning against one label set overfits it.
  const labeledIds = [...labels.keys()].sort((a, b) => a - b);
  const holdout = new Set(labeledIds.filter((_, i) => i % 5 === 4));
  const select = new Set(labeledIds.filter((id) => !holdout.has(id)));
  console.log(`\n[eval] ${labeledIds.length} labeled; ${select.size} selection / ${holdout.size} held out\n`);

  console.log("SELECTION METRICS — P@10, strict = borderline counts as NOT relevant (primary)");
  console.log("approach        P@10 strict   P@10 lenient");
  for (const [approach, ranked] of Object.entries(scores)) {
    const ids = projectRanking(ranked.map((r) => r.id), select);
    const strict = precisionAtK(ids, labels, K, "strict");
    const lenient = precisionAtK(ids, labels, K, "lenient");
    console.log(`${approach.padEnd(15)} ${strict.toFixed(2).padEnd(13)} ${lenient.toFixed(2)}`);
  }

  console.log("\nHELD-OUT FINAL CHECK (run once, AFTER choosing model + freshness weight):");
  for (const [approach, ranked] of Object.entries(scores)) {
    const ids = projectRanking(ranked.map((r) => r.id), holdout);
    const k = Math.min(K, ids.length);
    if (k === 0) continue;
    console.log(`${approach.padEnd(15)} P@${k} strict ${precisionAtK(ids, labels, k, "strict").toFixed(2)}`);
  }

  // Freshness-weight sanity (spec metric 4c): does the 0.15 blend pull anything labeled
  // irrelevant into a top-10 that similarity alone kept out?
  const byId = new Map(sample.map((s) => [s.id, s]));
  console.log("\nFRESHNESS BLEND SANITY (W_FRESH 0 -> 0.15, full labeled ranking):");
  for (const [approach, ranked] of Object.entries(scores)) {
    if (approach === "overlap") continue; // overlap scores aren't cosines; blend n/a
    const now = new Date();
    const blended = sortRecs(
      ranked.map((r) => {
        const s = byId.get(r.id)!;
        return {
          id: r.id,
          score: blendScore(r.score, freshness(s.publishedAt ? new Date(s.publishedAt) : null, new Date(s.firstSeenAt), now)),
        };
      }),
    ).map((r) => r.id);
    const simOnly = ranked.map((r) => r.id);
    const entered = blended.slice(0, K).filter((id) => !simOnly.slice(0, K).includes(id));
    const badEntrants = entered.filter((id) => labels.get(id) === "irrelevant");
    console.log(`${approach.padEnd(15)} entered top-10 via freshness: [${entered.join(", ") || "none"}]${badEntrants.length ? `  IRRELEVANT: [${badEntrants.join(", ")}]` : ""}`);
  }

  // Field-clustering DIAGNOSTIC ONLY (csField leaks into signature text — clustering
  // CANNOT be the selection metric; it would validate the leak, not the ranking).
  const vectorsPath = join(EVAL_DIR, "vectors.json");
  if (existsSync(vectorsPath)) {
    const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as Record<string, Record<string, Record<string, number[]>>>;
    const fieldOf = new Map(sample.map((s) => [s.id, s.csField ?? "null"]));
    console.log("\nFIELD CLUSTERING (diagnostic only): mean intra-field vs inter-field cosine");
    for (const model of MODELS) {
      for (const variant of ["sig", "raw"] as const) {
        const entries = Object.entries(vectors[model]?.[variant] ?? {});
        let intra = 0, nIntra = 0, inter = 0, nInter = 0;
        for (let i = 0; i < entries.length; i++) {
          for (let j = i + 1; j < entries.length; j++) {
            const sim = cosineSim(entries[i][1], entries[j][1]);
            if (fieldOf.get(Number(entries[i][0])) === fieldOf.get(Number(entries[j][0]))) { intra += sim; nIntra++; }
            else { inter += sim; nInter++; }
          }
        }
        if (nIntra && nInter) {
          console.log(`${variant}:${model.split("-")[0]}`.padEnd(15) + ` intra ${(intra / nIntra).toFixed(3)}  inter ${(inter / nInter).toFixed(3)}  gap ${((intra / nIntra) - (inter / nInter)).toFixed(3)}`);
        }
      }
    }

    // Soft-preference responsiveness (spec metric 4b): adding "prefer swe" to interests must
    // measurably promote SWE listings. Re-embeds the profile variant only (cheap).
    console.log("\nSOFT-PREFERENCE RESPONSIVENESS (interests += 'prefer software engineering roles'):");
    for (const model of MODELS) {
      const variantQ = {
        ...fixture.questionnaire,
        interests: `${fixture.questionnaire.interests} prefer software engineering roles`.trim(),
      };
      const [base, pref] = await embed(
        [
          profileCanonicalText(fixture.profile, fixture.questionnaire, model),
          profileCanonicalText(fixture.profile, variantQ, model),
        ],
        model,
      );
      const sigVecs = Object.entries(vectors[model]?.sig ?? {});
      const rankBy = (prof: number[]) =>
        sigVecs
          .map(([id, v]) => ({ id: Number(id), score: cosineSim(v, prof) }))
          .sort((a, b) => b.score - a.score || a.id - b.id)
          .slice(0, 20)
          .filter((r) => byId.get(r.id)?.csField === "swe").length;
      console.log(`sig:${model.split("-")[0]}`.padEnd(15) + ` swe in top-20: ${rankBy(base)} -> ${rankBy(pref)}`);
    }
  } else {
    console.log("\n(vectors.json missing — re-run pool to regenerate clustering + soft-preference diagnostics)");
  }

  console.log("\nNext: winner + these numbers -> research/embedding-model-bakeoff.md; if a raw baseline won, amend Decision 31.");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "sample") return cmdSample();
  if (cmd === "pool") return cmdPool();
  if (cmd === "score") return cmdScore();
  throw new Error("usage: npm run eval:recommend -- <sample|pool|score>");
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
