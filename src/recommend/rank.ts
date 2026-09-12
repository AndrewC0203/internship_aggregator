import { Prisma, type PrismaClient } from "@prisma/client";
import { EMBED_MODEL, TEMPLATE_VERSION } from "./config.js";
import { toVectorLiteral } from "../model/ollama.js";
import { loadRankingProfile } from "./profile.js";
import { hardConditions, type Questionnaire } from "./questionnaire.js";
import { freshness, blendScore, sortRecs, band } from "./score.js";
import { alignmentChip, selectivityBadge, type AlignmentChip } from "./labels.js";
import { validateSignature } from "./canonical.js";

// Ranking (spec "Ranking"): ONE $queryRaw returns ALL eligible rows with cosine distance —
// no candidate truncation. Top-K-by-similarity before blending could evict fresh-but-close
// listings; at ~2k rows the full set is measured-trivial, so the blend sees everything.
// Everything after the query is pure Node math (score, sort, paginate, labels) — no model
// calls on the query path; /foryou works with Ollama down.

export interface RecItem {
  id: number;
  company: string;
  title: string;
  url: string;
  location: string | null;
  opportunityType: string | null;
  csField: string | null;
  score: number;
  band: "strong" | "good" | "fair";
  matchedSkills: string[];
  chip: AlignmentChip;
  selectivity: string | null;
  applicationDeadline: Date | null;
  deadlineDaysLeft: number | null;
  citizenshipUnverified: boolean;
  locationUnresolved: boolean;
}

export type RecResult =
  | { state: "no_profile" }
  | { state: "stale_embedding" }
  | {
      state: "ready";
      total: number;
      excludedUnenriched: number;
      page: number;
      per: number;
      items: RecItem[];
    };

// Demonstrated-skills intersection (spec: matched-skills explanations read demonstrated
// skills ONLY — questionnaire interests never appear here). Both sides are canonical
// already; a listing with no valid signature matches nothing.
export function matchedSkills(
  profileSkills: string[],
  signature: { skills: string[] } | null,
): string[] {
  if (!signature) return [];
  const have = new Set(profileSkills);
  // Sorted so display order is deterministic regardless of stored signature order.
  return signature.skills.filter((s) => have.has(s)).sort();
}

export function paginate<T>(rows: T[], page: number, per: number): T[] {
  const p = Math.max(1, page);
  return rows.slice((p - 1) * per, p * per);
}

interface RankRow {
  id: number;
  company: string;
  title: string;
  url: string;
  location: string | null;
  opportunity_type: string | null;
  cs_field: string | null;
  citizenship_status: string | null;
  degree_status: string | null;
  grad_year_min: number | null;
  grad_year_max: number | null;
  loc_countries: string[];
  loc_us_states: string[];
  application_deadline: Date | null;
  published_at: Date | null;
  first_seen_at: Date;
  description_plain: string;
  signature: unknown;
  similarity: number;
}

const MS_PER_DAY = 86_400_000;

export async function recommend(
  prisma: PrismaClient,
  opts: { page?: number; per?: number } = {},
): Promise<RecResult> {
  const loaded = await loadRankingProfile(prisma);
  if (loaded.state !== "ready") return { state: loaded.state };
  const { profile, questionnaire, vector } = loaded;

  const hard = hardConditions(questionnaire);
  const hardSql = hard.length ? Prisma.sql`AND ${Prisma.join(hard, " AND ")}` : Prisma.empty;

  // The usability gate, spelled out: `signature IS NOT NULL` is NOT sufficient — a
  // signature can save while its embed fails, and a model/template mismatch means the
  // vector lives in a different space than the profile's. Both checks, every query.
  const usable = Prisma.sql`embedding IS NOT NULL
    AND embedding_model = ${EMBED_MODEL} AND template_version = ${TEMPLATE_VERSION}`;
  const vec = toVectorLiteral(vector);

  const [rows, excludedRows] = await Promise.all([
    prisma.$queryRaw<RankRow[]>`
      SELECT id, company, title, url, location, opportunity_type, cs_field,
             citizenship_status, degree_status, grad_year_min, grad_year_max,
             loc_countries, loc_us_states, application_deadline, published_at,
             first_seen_at, description_plain, signature,
             1 - (embedding <=> ${vec}::vector) AS similarity
      FROM listings
      WHERE is_listed AND ${usable} ${hardSql}`,
    // The gate's complement under the SAME filters: how many matching listings are not yet
    // enriched. Surfaced in the UI — a half-enriched corpus degrades LOUDLY, not silently.
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM listings
      WHERE is_listed AND NOT (${usable}) ${hardSql}`,
  ]);

  const now = new Date();
  const scored = sortRecs(
    rows.map((r) => ({
      row: r,
      id: r.id,
      score: blendScore(r.similarity, freshness(r.published_at, r.first_seen_at, now)),
    })),
  );

  const page = Math.max(1, opts.page ?? 1);
  const per = Math.min(100, Math.max(10, opts.per ?? 25));
  const hasLocationPrefs =
    questionnaire.locStates.length > 0 || questionnaire.locCountries.length > 0;

  const items: RecItem[] = paginate(scored, page, per).map(({ row, score }) => {
    const sig = validateSignature(row.signature);
    const daysLeft = row.application_deadline
      ? Math.ceil((row.application_deadline.getTime() - now.getTime()) / MS_PER_DAY)
      : null;
    return {
      id: row.id,
      company: row.company,
      title: row.title,
      url: row.url,
      location: row.location,
      opportunityType: row.opportunity_type,
      csField: row.cs_field,
      score,
      band: band(score),
      matchedSkills: matchedSkills(profile.skills, sig),
      chip: alignmentChip(
        {
          descriptionPlain: row.description_plain,
          gradYearMin: row.grad_year_min,
          gradYearMax: row.grad_year_max,
          citizenshipStatus: row.citizenship_status,
          degreeStatus: row.degree_status,
        },
        questionnaire,
      ),
      selectivity: selectivityBadge(row.company),
      applicationDeadline: row.application_deadline,
      deadlineDaysLeft: daysLeft,
      // Deadlines are DISPLAYED with urgency, never scored (spec) — daysLeft is render fuel.
      citizenshipUnverified:
        row.citizenship_status === null || row.citizenship_status === "unknown",
      locationUnresolved:
        hasLocationPrefs && row.loc_countries.length === 0 && row.loc_us_states.length === 0,
    };
  });

  return {
    state: "ready",
    total: rows.length,
    excludedUnenriched: Number(excludedRows[0]?.n ?? 0n),
    page,
    per,
    items,
  };
}
