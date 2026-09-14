import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { OllamaError } from "../model/ollama.js";
import { extractProfile } from "../model/profile-extract.js";
import {
  ensureProfileRow,
  publishProfile,
  saveQuestionnaire,
  loadRankingProfile,
} from "../recommend/profile.js";
import { parseQuestionnaire } from "../recommend/questionnaire.js";
import { canonicalizeSkills } from "../recommend/aliases.js";
import { profileCanonicalText, type ProfileJson } from "../recommend/canonical.js";
import { recommend, rankAgainst } from "../recommend/rank.js";
import { EMBED_MODEL, TEMPLATE_VERSION } from "../recommend/config.js";
import { embed } from "../model/ollama.js";

// Recommendation API (spec "API + UI"). Thin routes: every rule lives in the recommend/
// modules; this file only parses, dispatches, and maps outcomes to status codes.
//
// Error contract:
//   503 ollama_down          — profile edits + extraction need the local model; ranking never does
//   409 revision_conflict    — a newer edit won the optimistic-concurrency race; reload, redo
//   409 profile_embedding_stale — stored profile vector disagrees with current config; loud,
//                                with the remediation spelled out (re-approve to re-embed)

const ollamaDown = (err: unknown): boolean =>
  err instanceof OllamaError && (err.status === undefined || err.status === 429 || err.status >= 500);

function parseProfileBody(raw: unknown): ProfileJson | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.skills) || !o.skills.every((s) => typeof s === "string")) return null;
  if (typeof o.focus !== "string" || o.focus.trim().length === 0) return null;
  const skills = canonicalizeSkills(o.skills);
  return skills.length > 0 ? { skills, focus: o.focus.trim() } : null;
}

export function registerRecommendRoutes(app: FastifyInstance): void {
  // Paste resume -> 14B quote-grounded extraction -> extracted_profile (model column only;
  // `profile` is untouched until the human approves via PUT /api/profile).
  app.post<{ Body: { resumeText?: string } }>("/api/profile/resume", async (req, reply) => {
    const resumeText = req.body?.resumeText;
    if (typeof resumeText !== "string" || resumeText.trim().length < 40) {
      return reply.code(400).send({ error: "resumeText required (paste the plain text)" });
    }
    await ensureProfileRow(prisma);
    try {
      const extracted = await extractProfile(resumeText);
      await prisma.userProfile.update({
        where: { id: 1 },
        data: { resumeText, extractedProfile: extracted as object },
      });
      return { extracted };
    } catch (err) {
      if (ollamaDown(err)) {
        return reply.code(503).send({ error: "ollama_down", hint: "start `ollama serve`" });
      }
      // Grounding failure (focus evidence not in resume) or schema bug: honest 422, the
      // user edits manually instead of receiving invented content.
      const reason = err instanceof Error ? err.message : String(err);
      return reply.code(422).send({ error: "extraction_failed", reason });
    }
  });

  app.get("/api/profile", async () => {
    await ensureProfileRow(prisma);
    const rows = await prisma.$queryRaw<
      Array<{
        resume_text: string | null;
        extracted_profile: unknown;
        profile: unknown;
        questionnaire: unknown;
        revision: number;
        embedding_model: string | null;
        template_version: number | null;
        has_embedding: boolean;
      }>
    >`SELECT resume_text, extracted_profile, profile, questionnaire, revision,
             embedding_model, template_version, (embedding IS NOT NULL) AS has_embedding
      FROM user_profile WHERE id = 1`;
    const r = rows[0];
    return {
      resumeText: r.resume_text,
      extractedProfile: r.extracted_profile,
      profile: r.profile,
      questionnaire: r.questionnaire,
      revision: r.revision,
      embedding: r.has_embedding
        ? {
            model: r.embedding_model,
            templateVersion: r.template_version,
            current: r.embedding_model === EMBED_MODEL && r.template_version === TEMPLATE_VERSION,
          }
        : null,
    };
  });

  // Approve/publish: profile + questionnaire + embedding land together (see profile.ts).
  app.put<{ Body: { profile?: unknown; questionnaire?: unknown; revision?: number } }>(
    "/api/profile",
    async (req, reply) => {
      const profile = parseProfileBody(req.body?.profile);
      const revision = req.body?.revision;
      if (!profile) return reply.code(400).send({ error: "bad profile (skills[] + focus required)" });
      if (!Number.isInteger(revision)) return reply.code(400).send({ error: "revision required" });
      await ensureProfileRow(prisma);
      try {
        const result = await publishProfile(prisma, {
          profile,
          questionnaire: parseQuestionnaire(req.body?.questionnaire),
          expectedRevision: revision as number,
        });
        if (!result.ok) return reply.code(409).send({ error: "revision_conflict" });
        return { ok: true, revision: result.revision };
      } catch (err) {
        if (ollamaDown(err)) {
          return reply.code(503).send({ error: "ollama_down", hint: "start `ollama serve`" });
        }
        throw err;
      }
    },
  );

  app.put<{ Body: { questionnaire?: unknown; revision?: number } }>(
    "/api/profile/questionnaire",
    async (req, reply) => {
      const revision = req.body?.revision;
      if (!Number.isInteger(revision)) return reply.code(400).send({ error: "revision required" });
      await ensureProfileRow(prisma);
      try {
        const result = await saveQuestionnaire(prisma, {
          questionnaire: parseQuestionnaire(req.body?.questionnaire),
          expectedRevision: revision as number,
        });
        if (!result.ok) return reply.code(409).send({ error: "revision_conflict" });
        return { ok: true, revision: result.revision };
      } catch (err) {
        if (ollamaDown(err)) {
          // Only a SOFT edit reaches the model (re-embed); hard-only edits are SQL and
          // succeed with Ollama down — exactly the spec's availability split.
          return reply.code(503).send({ error: "ollama_down", hint: "start `ollama serve`" });
        }
        throw err;
      }
    },
  );

  // Stateless tryout (manual testing / demo): rank the corpus against a PASTED resume —
  // extract + embed + rank happen in-memory, NOTHING is persisted (not the resume, not the
  // profile — someone else's resume is PII and must not land in user_profile or anywhere).
  // Optional `interests` feeds the Seeking: section so soft steering is testable too.
  app.post<{ Body: { resumeText?: string; interests?: string; per?: number } }>(
    "/api/tryout",
    async (req, reply) => {
      const resumeText = req.body?.resumeText;
      if (typeof resumeText !== "string" || resumeText.trim().length < 40) {
        return reply.code(400).send({ error: "resumeText required (paste the plain text)" });
      }
      try {
        const extracted = await extractProfile(resumeText);
        const questionnaire = parseQuestionnaire({
          interests: typeof req.body?.interests === "string" ? req.body.interests : "",
        });
        const profile = { skills: extracted.skills, focus: extracted.focus };
        const [vector] = await embed(
          [profileCanonicalText(profile, questionnaire, EMBED_MODEL)],
          EMBED_MODEL,
        );
        const ranked = await rankAgainst(prisma, {
          profile,
          questionnaire,
          vector,
          page: 1,
          per: Math.min(50, Math.max(5, Number(req.body?.per) || 10)),
        });
        return { extracted, ...ranked };
      } catch (err) {
        if (ollamaDown(err)) {
          return reply.code(503).send({ error: "ollama_down", hint: "start `ollama serve`" });
        }
        const reason = err instanceof Error ? err.message : String(err);
        return reply.code(422).send({ error: "extraction_failed", reason });
      }
    },
  );

  app.get<{ Querystring: { page?: string; per?: string } }>(
    "/api/recommendations",
    async (req, reply) => {
      const result = await recommend(prisma, {
        page: Number(req.query.page) || 1,
        per: Number(req.query.per) || 25,
      });
      if (result.state === "no_profile") return { needsSetup: true };
      if (result.state === "stale_embedding") {
        return reply.code(409).send({
          error: "profile_embedding_stale",
          remediation: "re-approve the profile (PUT /api/profile) to re-embed under current config",
        });
      }
      return result;
    },
  );
}
