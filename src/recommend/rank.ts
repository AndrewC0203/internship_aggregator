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
  // Role grouping (Decision 28 applied here): additional same-role postings folded into
  // this entry — their distinct locations, and how many rows the role spans in total.
  variantCount: number;
  locations: string[];
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

// Role grouping, the Decision 28 lesson applied to recommendations: same-titled postings
// at different locations are near-identical signatures with near-identical cosines, so
// ungrouped they flood the top-K (observed: one Stripe new-grad role occupying 5 of 10
// tryout slots). One entry per trimmed (company, title); the best-ranked variant is the
// representative, the others contribute their locations and a count. Exported for tests.
export function groupByRole<T extends { company: string; title: string; location: string | null }>(
  sorted: Array<{ row: T; id: number; score: number }>,
): Array<{ rep: { row: T; id: number; score: number }; variantCount: number; locations: string[] }> {
  const byKey = new Map<
    string,
    { rep: { row: T; id: number; score: number }; variantCount: number; locations: string[] }
  >();
  for (const s of sorted) {
    const key = `${s.row.company.trim()}::${s.row.title.trim()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        rep: s,
        variantCount: 1,
        locations: s.row.location ? [s.row.location] : [],
      });
    } else {
      existing.variantCount++;
      if (s.row.location && !existing.locations.includes(s.row.location)) {
        existing.locations.push(s.row.location);
      }
    }
  }
  // Map preserves insertion order = best-rank-first, since input arrives sorted.
  return [...byKey.values()];
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
  return rankAgainst(prisma, { ...loaded, ...opts });
}

// The ranking core, decoupled from WHERE the profile comes from: recommend() feeds it the
// stored approved profile; the /tryout flow feeds it an ad-hoc extracted profile + vector
// that never touches user_profile. Same query, same gate, same scoring either way.
export async function rankAgainst(
  prisma: PrismaClient,
  args: {
    profile: { skills: string[] };
    questionnaire: Questionnaire;
    vector: number[];
    page?: number;
    per?: number;
  },
): Promise<Extract<RecResult, { state: "ready" }>> {
  const { profile, questionnaire, vector } = args;
  const opts = { page: args.page, per: args.per };

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
  // Sort listings, then fold same-role variants (one Stripe role must not eat five of ten
  // slots); bands + pagination + total all operate on ROLES, matching what the board's
  // cards taught users to expect. Global rank survives pagination — bands are
  // rank-relative to the WHOLE eligible role set (see score.ts band()).
  const grouped = groupByRole(
    sortRecs(
      rows.map((r) => ({
        row: r,
        id: r.id,
        score: blendScore(r.similarity, freshness(r.published_at, r.first_seen_at, now)),
      })),
    ),
  ).map((g, rank) => ({ ...g, rank }));

  const page = Math.max(1, opts.page ?? 1);
  const per = Math.min(100, Math.max(10, opts.per ?? 25));
  const hasLocationPrefs =
    questionnaire.locStates.length > 0 || questionnaire.locCountries.length > 0;

  const items: RecItem[] = paginate(grouped, page, per).map(({ rep, variantCount, locations, rank }) => {
    const { row, score } = rep;
    const sig = validateSignature(row.signature);
    const daysLeft = row.application_deadline
      ? Math.ceil((row.application_deadline.getTime() - now.getTime()) / MS_PER_DAY)
      : null;
    return {
      id: row.id,
      variantCount,
      locations,
      company: row.company,
      title: row.title,
      url: row.url,
      location: row.location,
      opportunityType: row.opportunity_type,
      csField: row.cs_field,
      score,
      band: band(rank, grouped.length),
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
    // Distinct ROLES, not rows — the unit the user sees (same redefinition Decision 28
    // made for the board's dup metric).
    total: grouped.length,
    excludedUnenriched: Number(excludedRows[0]?.n ?? 0n),
    page,
    per,
    items,
  };
}
