// Fastify server (Decision 20): one process serves the SSR search page and the JSON API,
// both rendering from the same search() query layer. `npm run serve`.
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { parseParams, runSearch } from "./search.js";
import { renderPage } from "./render.js";
import { registerRecommendRoutes } from "./recommend.js";
import { renderProfilePage } from "./render-profile.js";
import { renderTryoutPage } from "./render-tryout.js";
import { ensureProfileRow } from "../recommend/profile.js";
import { parseQuestionnaire } from "../recommend/questionnaire.js";
import { EMBED_MODEL, TEMPLATE_VERSION } from "../recommend/config.js";

const app = Fastify({ logger: { level: "warn" } });

// Self-hosted fonts. Hand-rolled instead of @fastify/static because it's exactly one file —
// the allowlist doubles as the path-traversal guard. (national-park.woff2 retired with the
// Dispatch Board world, 2026-08-28.)
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "public", "fonts");
const FONTS = new Set(["chivo-mono.woff2"]);
app.get<{ Params: { file: string } }>("/fonts/:file", async (req, reply) => {
  if (!FONTS.has(req.params.file)) return reply.code(404).send();
  reply
    .type("font/woff2")
    .header("cache-control", "public, max-age=31536000, immutable")
    .send(await readFile(join(FONT_DIR, req.params.file)));
});

// SSR page — the hub itself.
app.get("/", async (req, reply) => {
  const raw = parseParams(req.query as Record<string, unknown>);
  const { params, result, profileState } = await runSearch(prisma, raw);
  reply.type("text/html; charset=utf-8").send(renderPage(params, result, profileState));
});

app.get("/tryout", async (_req, reply) => {
  reply.type("text/html; charset=utf-8").send(renderTryoutPage());
});

app.get("/profile", async (_req, reply) => {
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
  reply.type("text/html; charset=utf-8").send(
    renderProfilePage({
      resumeText: r.resume_text,
      extractedProfile: r.extracted_profile as never,
      profile: r.profile as never,
      questionnaire: parseQuestionnaire(r.questionnaire),
      revision: r.revision,
      embeddingCurrent: r.has_embedding
        ? r.embedding_model === EMBED_MODEL && r.template_version === TEMPLATE_VERSION
        : null,
    }),
  );
});

// Same query, JSON shape — the search API Phase 1 promises.
app.get("/api/search", async (req) => {
  const raw = parseParams(req.query as Record<string, unknown>);
  const { result } = await runSearch(prisma, raw);
  return result;
});

// Profile flow (Decisions 29-32) + /tryout; /search's own paste-and-go covers ranking
// now (Decision 34) — /foryou retired, see Decision 34's addendum.
registerRecommendRoutes(app);

// Apply-status upsert/clear (Decision 21). PUT with {status: null} deletes the row —
// "not_applied" is row absence, not a stored value.
app.put<{ Params: { id: string }; Body: { status?: string | null; note?: string | null } }>(
  "/api/applications/:id",
  async (req, reply) => {
    const listingId = Number(req.params.id);
    // Bounded to int4: Listing.id is Postgres Int, and an oversized JS integer passes
    // Number.isInteger but throws inside Prisma (500) instead of the intended 400.
    if (!Number.isInteger(listingId) || listingId < 1 || listingId > 2147483647) {
      return reply.code(400).send({ error: "bad id" });
    }
    const { status, note } = req.body ?? {};
    // Fastify's Body generic is compile-time only (no schema on this route) — an unvalidated
    // non-string note reached Prisma and 500'd with the raw validation message in the body.
    if (note !== undefined && note !== null && typeof note !== "string") {
      return reply.code(400).send({ error: "bad note" });
    }
    const allowed = ["saved", "applied", "interviewing", "offer", "rejected"];
    if (status == null) {
      await prisma.application.deleteMany({ where: { listingId } });
      return { listingId, status: null };
    }
    if (!allowed.includes(status)) return reply.code(400).send({ error: "bad status" });
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true } });
    if (!listing) return reply.code(404).send({ error: "unknown listing" });
    const row = await prisma.application.upsert({
      where: { listingId },
      create: { listingId, status: status as never, note: note ?? null },
      // note: undefined leaves an existing note untouched on a status-only update
      update: { status: status as never, ...(note !== undefined ? { note } : {}) },
    });
    return { listingId, status: row.status, note: row.note };
  },
);

const port = Number(process.env.PORT) || 3000;
app
  .listen({ port, host: "127.0.0.1" })
  .then(() => console.log(`hub listening on http://127.0.0.1:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
