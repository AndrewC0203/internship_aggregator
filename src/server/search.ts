// Search query layer (Decision 20). One function builds the WHERE from parsed params; both
// the JSON API and the SSR page call it, so there is never a "page query" and an "API query"
// drifting apart — the API the UI renders from is the API the project exposes.
import { Prisma, PrismaClient } from "@prisma/client";

// Fresh-window: a listing counts as NEW while first_seen_at is within this many days. The
// refresh is daily, so 3 days ≈ "the last few runs" — wide enough that a skipped day doesn't
// silently empty the queue, narrow enough that NEW stays a queue, not the whole corpus.
export const NEW_WINDOW_DAYS = 3;

export interface SearchParams {
  q?: string; // free text over title + company
  type?: string[]; // opportunity_type values
  field?: string[]; // cs_field values
  country?: string[]; // ISO alpha-2 vs loc_countries
  state?: string[]; // USPS codes vs loc_us_states
  gradYear?: number; // class year compatibility
  status?: string[]; // application status; "none" = untouched rows
  newOnly?: boolean; // only rows inside the NEW window
  sort?: "first_seen" | "published" | "company";
  page?: number; // 1-based
  per?: number;
}

const ALL_TYPES = ["internship", "co_op", "fellowship", "new_grad", "research", "part_time"];
const ALL_FIELDS = ["swe", "ml_ai", "data", "quant", "security", "hardware_embedded", "devops_infra", "it", "product", "other"];
const ALL_STATUSES = ["saved", "applied", "interviewing", "offer", "rejected"];

// Parse raw querystring values (everything arrives as strings) into typed params,
// dropping anything that isn't a known enum value rather than erroring.
export function parseParams(raw: Record<string, unknown>): SearchParams {
  const list = (v: unknown): string[] =>
    typeof v === "string" ? v.split(",").filter(Boolean) : Array.isArray(v) ? v.map(String) : [];
  const keep = (vals: string[], allowed: string[]) => {
    const out = vals.filter((v) => allowed.includes(v));
    return out.length ? out : undefined;
  };
  const gradYear = Number(raw.gradYear);
  const page = Math.max(1, Number(raw.page) || 1);
  const sort = raw.sort === "published" || raw.sort === "company" ? raw.sort : "first_seen";
  return {
    q: typeof raw.q === "string" && raw.q.trim() ? raw.q.trim() : undefined,
    type: keep(list(raw.type), ALL_TYPES),
    field: keep(list(raw.field), ALL_FIELDS),
    country: list(raw.country).length ? list(raw.country).map((c) => c.toUpperCase()) : undefined,
    state: list(raw.state).length ? list(raw.state).map((s) => s.toUpperCase()) : undefined,
    gradYear: Number.isInteger(gradYear) && gradYear >= 2020 && gradYear <= 2040 ? gradYear : undefined,
    status: keep(list(raw.status), [...ALL_STATUSES, "none"]),
    newOnly: raw.new === "1" || raw.new === "true",
    sort,
    page,
    per: Math.min(200, Math.max(10, Number(raw.per) || 50)),
  };
}

export function newCutoff(now = new Date()): Date {
  return new Date(now.getTime() - NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

// Build the WHERE for a param set, optionally omitting one facet's own constraint. The
// omission is what makes rail counts honest faceted-search counts: the "internship (663)"
// count must answer "what would I get if I ALSO clicked this", so a facet's own current
// selection can't constrain its own counts.
export function buildWhere(p: SearchParams, omit?: "type" | "field" | "country" | "state" | "status"): Prisma.ListingWhereInput {
  const and: Prisma.ListingWhereInput[] = [{ isListed: true }];
  if (p.q) {
    and.push({
      OR: [
        { title: { contains: p.q, mode: "insensitive" } },
        { company: { contains: p.q, mode: "insensitive" } },
      ],
    });
  }
  if (p.type && omit !== "type") and.push({ opportunityType: { in: p.type as never[] } });
  if (p.field && omit !== "field") and.push({ csField: { in: p.field as never[] } });
  if (p.country && omit !== "country") and.push({ locCountries: { hasSome: p.country } });
  if (p.state && omit !== "state") and.push({ locUsStates: { hasSome: p.state } });
  if (p.gradYear) {
    // Class-year compatibility (Decision 17 semantics): a listing matches when its stated
    // window includes the year OR it states no window at all. Excluding the unknowns would
    // hide 86% of the corpus (measured 2026-08-27) behind a filter most postings never state.
    and.push({
      AND: [
        { OR: [{ gradYearMin: null }, { gradYearMin: { lte: p.gradYear } }] },
        { OR: [{ gradYearMax: null }, { gradYearMax: { gte: p.gradYear } }] },
      ],
    });
  }
  if (p.newOnly) and.push({ firstSeenAt: { gte: newCutoff() } });
  if (p.status && omit !== "status") {
    const wantNone = p.status.includes("none");
    const real = p.status.filter((s) => s !== "none");
    const or: Prisma.ListingWhereInput[] = [];
    if (real.length) or.push({ application: { status: { in: real as never[] } } });
    if (wantNone) or.push({ application: null });
    and.push({ OR: or });
  }
  return { AND: and };
}

export interface SearchResult {
  total: number;
  newCount: number; // rows in the NEW window under current filters
  page: number;
  per: number;
  rows: Array<{
    id: number;
    company: string;
    title: string;
    location: string | null;
    locUsStates: string[];
    locCountries: string[];
    opportunityType: string | null;
    csField: string | null;
    gradYearMin: number | null;
    gradYearMax: number | null;
    citizenshipStatus: string | null;
    degreeStatus: string | null;
    url: string;
    firstSeenAt: Date;
    publishedAt: Date | null;
    applicationDeadline: Date | null;
    isNew: boolean;
    status: string | null; // application status, null = untouched
    note: string | null;
  }>;
  facets: {
    type: Record<string, number>;
    field: Record<string, number>;
    state: Record<string, number>;
    country: Record<string, number>;
    status: Record<string, number>; // includes "none"
  };
}

export async function search(prisma: PrismaClient, p: SearchParams): Promise<SearchResult> {
  const where = buildWhere(p);
  const cutoff = newCutoff();
  const orderBy: Prisma.ListingOrderByWithRelationInput[] =
    p.sort === "published"
      ? [{ publishedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }]
      : p.sort === "company"
        ? [{ company: "asc" }, { title: "asc" }]
        : [{ firstSeenAt: "desc" }, { id: "desc" }];

  const [total, newCount, rows, typeGroups, fieldGroups, statusRows, stateRows, countryRows] =
    await Promise.all([
      prisma.listing.count({ where }),
      prisma.listing.count({ where: { AND: [where, { firstSeenAt: { gte: cutoff } }] } }),
      prisma.listing.findMany({
        where,
        orderBy,
        skip: ((p.page ?? 1) - 1) * (p.per ?? 50),
        take: p.per ?? 50,
        select: {
          id: true, company: true, title: true, location: true,
          locUsStates: true, locCountries: true,
          opportunityType: true, csField: true,
          gradYearMin: true, gradYearMax: true, citizenshipStatus: true, degreeStatus: true,
          url: true, firstSeenAt: true, publishedAt: true, applicationDeadline: true,
          application: { select: { status: true, note: true } },
        },
      }),
      prisma.listing.groupBy({ by: ["opportunityType"], where: buildWhere(p, "type"), _count: true }),
      prisma.listing.groupBy({ by: ["csField"], where: buildWhere(p, "field"), _count: true }),
      // Status counts need the join; groupBy can't reach across it, so count per status.
      Promise.all(
        [...ALL_STATUSES, "none"].map(async (s) => {
          const w = buildWhere(p, "status");
          const c = await prisma.listing.count({
            where: s === "none" ? { AND: [w, { application: null }] } : { AND: [w, { application: { status: s as never } }] },
          });
          return [s, c] as const;
        }),
      ),
      // Array facets: groupBy can't unnest arrays — raw SQL is the honest tool here.
      facetArrayCounts(prisma, buildWhere(p, "state"), "loc_us_states"),
      facetArrayCounts(prisma, buildWhere(p, "country"), "loc_countries"),
    ]);

  return {
    total,
    newCount,
    page: p.page ?? 1,
    per: p.per ?? 50,
    rows: rows.map((r) => ({
      id: r.id, company: r.company, title: r.title, location: r.location,
      locUsStates: r.locUsStates, locCountries: r.locCountries,
      opportunityType: r.opportunityType, csField: r.csField,
      gradYearMin: r.gradYearMin, gradYearMax: r.gradYearMax,
      citizenshipStatus: r.citizenshipStatus,
      degreeStatus: r.degreeStatus,
      url: r.url, firstSeenAt: r.firstSeenAt, publishedAt: r.publishedAt,
      applicationDeadline: r.applicationDeadline,
      isNew: r.firstSeenAt >= cutoff,
      status: r.application?.status ?? null,
      note: r.application?.note ?? null,
    })),
    facets: {
      type: Object.fromEntries(typeGroups.filter((g) => g.opportunityType).map((g) => [g.opportunityType as string, g._count])),
      field: Object.fromEntries(fieldGroups.filter((g) => g.csField).map((g) => [g.csField as string, g._count])),
      state: stateRows,
      country: countryRows,
      status: Object.fromEntries(statusRows),
    },
  };
}

// Count listings per array element (e.g. per US state) under a WHERE. Prisma's groupBy can't
// unnest scalar lists, so this routes the same WHERE through findMany for ids (keeping the
// filter logic in exactly one place) and unnests in SQL over that id set. At 1.8k rows the
// id-list roundtrip is noise; revisit only if the corpus grows 100x.
async function facetArrayCounts(
  prisma: PrismaClient,
  where: Prisma.ListingWhereInput,
  column: "loc_us_states" | "loc_countries",
): Promise<Record<string, number>> {
  const ids = await prisma.listing.findMany({ where, select: { id: true } });
  if (ids.length === 0) return {};
  const idList = Prisma.join(ids.map((r) => r.id));
  const col = Prisma.raw(column); // safe: column is a closed union, never user input
  const rows = await prisma.$queryRaw<Array<{ v: string; c: bigint }>>`
    SELECT unnest(${col}) AS v, count(*) AS c
    FROM listings WHERE id IN (${idList})
    GROUP BY v ORDER BY c DESC`;
  return Object.fromEntries(rows.map((r) => [r.v, Number(r.c)]));
}
