import type { PrismaClient } from "@prisma/client";
import { embed, toVectorLiteral } from "../model/ollama.js";
import { EMBED_MODEL, TEMPLATE_VERSION } from "./config.js";
import { profileCanonicalText, type ProfileJson } from "./canonical.js";
import { parseQuestionnaire, type Questionnaire } from "./questionnaire.js";
import { getDraft } from "./draftCache.js";

// Profile publish + load (spec "Consistency rules"). The invariants this file owns:
//   - approved inputs + their matching embedding always land TOGETHER (one guarded UPDATE)
//   - the embedding is generated OUTSIDE any transaction (model calls never hold a txn open)
//   - optimistic concurrency via `revision`: 0 rows updated = a newer edit won -> conflict
//     surfaced, never overwritten
//   - ranking reads hard-error loudly when the stored vector's config disagrees with
//     current config (same two-field gate as listings)

// Re-embed iff canonical text changed. Types/targetFields/interests live in the Seeking:
// section (soft); grad years, work-auth, locations never appear in it (hard, SQL-only).
// Comparing rendered text — instead of maintaining a soft-field list — cannot drift from
// what actually gets embedded.
export function softEditRequiresReembed(
  profile: ProfileJson,
  before: Questionnaire,
  after: Questionnaire,
): boolean {
  return (
    profileCanonicalText(profile, before, EMBED_MODEL) !==
    profileCanonicalText(profile, after, EMBED_MODEL)
  );
}

// pgvector's ::text form is '[v1,v2,...]' — parse back to numbers for the ranking query.
// Null/malformed -> null (treated as "no usable embedding", never a guess).
export function parseVectorText(text: string | null): number[] | null {
  if (!text || !text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return null; // "[]": "".split(",") is [""] and Number("") is 0 — not a vector
  const vals = inner.split(",").map(Number);
  return vals.length > 0 && vals.every((v) => Number.isFinite(v)) ? vals : null;
}

// The single-row table's row, created on first touch. id is always 1.
export async function ensureProfileRow(prisma: PrismaClient): Promise<void> {
  await prisma.userProfile.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

export type PublishResult = { ok: true; revision: number } | { ok: false; conflict: true };

// Publish = approve: profile + questionnaire + embedding land together, guarded by revision.
export async function publishProfile(
  prisma: PrismaClient,
  args: { profile: ProfileJson; questionnaire: Questionnaire; expectedRevision: number },
): Promise<PublishResult> {
  const text = profileCanonicalText(args.profile, args.questionnaire, EMBED_MODEL);
  // Model call OUTSIDE any transaction — embedding can take seconds; holding a txn open
  // across it would serialize every other write on this table for no correctness gain.
  const [vector] = await embed([text], EMBED_MODEL);

  const updated = await prisma.$executeRaw`
    UPDATE user_profile
    SET profile = ${JSON.stringify(args.profile)}::jsonb,
        questionnaire = ${JSON.stringify(args.questionnaire)}::jsonb,
        embedding = ${toVectorLiteral(vector)}::vector,
        embedding_model = ${EMBED_MODEL},
        template_version = ${TEMPLATE_VERSION},
        revision = revision + 1,
        updated_at = now()
    WHERE id = 1 AND revision = ${args.expectedRevision}`;

  return updated === 1
    ? { ok: true, revision: args.expectedRevision + 1 }
    : { ok: false, conflict: true };
}

// Questionnaire-only save. Hard-only edits skip the embed entirely (SQL-only, works with
// Ollama down); a soft edit routes through the full publish path so the stored vector can
// never disagree with the stored Seeking: text.
export async function saveQuestionnaire(
  prisma: PrismaClient,
  args: { questionnaire: Questionnaire; expectedRevision: number },
): Promise<PublishResult | { ok: false; needsProfile: true }> {
  const row = await prisma.userProfile.findUnique({
    where: { id: 1 },
    select: { profile: true, questionnaire: true },
  });
  const profile = (row?.profile ?? null) as ProfileJson | null;
  if (!profile) {
    // No approved profile yet: store answers for later; nothing is embedded, nothing ranks.
    const updated = await prisma.$executeRaw`
      UPDATE user_profile
      SET questionnaire = ${JSON.stringify(args.questionnaire)}::jsonb,
          revision = revision + 1, updated_at = now()
      WHERE id = 1 AND revision = ${args.expectedRevision}`;
    return updated === 1
      ? { ok: true, revision: args.expectedRevision + 1 }
      : { ok: false, conflict: true };
  }

  const before = parseQuestionnaire(row?.questionnaire);
  if (softEditRequiresReembed(profile, before, args.questionnaire)) {
    return publishProfile(prisma, {
      profile,
      questionnaire: args.questionnaire,
      expectedRevision: args.expectedRevision,
    });
  }

  const updated = await prisma.$executeRaw`
    UPDATE user_profile
    SET questionnaire = ${JSON.stringify(args.questionnaire)}::jsonb,
        revision = revision + 1, updated_at = now()
    WHERE id = 1 AND revision = ${args.expectedRevision}`;
  return updated === 1
    ? { ok: true, revision: args.expectedRevision + 1 }
    : { ok: false, conflict: true };
}

export type RankingProfile =
  | { state: "ready"; profile: ProfileJson; questionnaire: Questionnaire; vector: number[] }
  | { state: "no_profile" } // -> setup CTA, not an error
  | { state: "stale_embedding" }; // -> loud 409 + "re-approve profile" remediation

// What ranking reads. The two-field config gate mirrors the listing usability gate: a
// template bump must not compare new-template listing vectors against an old-template
// profile vector — that mismatch is a HARD error, never a silent degradation.
export async function loadRankingProfile(prisma: PrismaClient): Promise<RankingProfile> {
  const rows = await prisma.$queryRaw<
    Array<{
      profile: unknown;
      questionnaire: unknown;
      embedding_text: string | null;
      embedding_model: string | null;
      template_version: number | null;
    }>
  >`SELECT profile, questionnaire, embedding::text AS embedding_text,
           embedding_model, template_version
    FROM user_profile WHERE id = 1`;

  const row = rows[0];
  const profile = (row?.profile ?? null) as ProfileJson | null;
  if (!row || !profile) return { state: "no_profile" };

  const vector = parseVectorText(row.embedding_text);
  if (!vector || row.embedding_model !== EMBED_MODEL || row.template_version !== TEMPLATE_VERSION) {
    return { state: "stale_embedding" };
  }

  return { state: "ready", profile, questionnaire: parseQuestionnaire(row.questionnaire), vector };
}

export type ActiveProfile =
  | { state: "draft"; profile: ProfileJson; vector: number[] }
  | { state: "approved"; profile: ProfileJson; vector: number[] }
  | { state: "stale" } // approved profile exists but its vector predates current config
  | { state: "none" };

// What /search's ranked path reads (Decision 34). Precedence: an in-memory paste-and-go
// draft (draftCache.ts) beats the persisted approved profile — most-recent-action wins,
// same instinct as /tryout overriding /foryou for one request, just persisted across
// requests instead of one-shot. Falls through silently on a stale/config-mismatched draft
// (drop it, don't error) since it's ephemeral by design — the honest response to "the
// embedding config changed" here is just "re-paste", not a loud 409 like the approved
// profile's stale-embedding case gets.
export async function loadActiveProfile(prisma: PrismaClient): Promise<ActiveProfile> {
  const draft = getDraft();
  if (draft && draft.embeddingModel === EMBED_MODEL && draft.templateVersion === TEMPLATE_VERSION) {
    return { state: "draft", profile: draft.profile, vector: draft.vector };
  }
  const loaded = await loadRankingProfile(prisma);
  if (loaded.state === "ready") {
    return { state: "approved", profile: loaded.profile, vector: loaded.vector };
  }
  // stale_embedding must stay distinguishable from "none": flattening it made a template/
  // model bump silently un-person the approved profile (fit sort vanished, setup CTA shown)
  // instead of surfacing the documented "re-approve to re-embed" remediation.
  if (loaded.state === "stale_embedding") return { state: "stale" };
  return { state: "none" };
}
