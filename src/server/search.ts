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
  // Location is ONE dimension across two facets: state and country selections union
  // (NY + India = listed in either), while other facets still intersect. Omitting either
  // location facet drops the whole group, so state/country chip counts answer "what would
  // I get if this were my location filter" unconstrained by the other location picks.
  if (omit !== "state" && omit !== "country") {
    const loc: Prisma.ListingWhereInput[] = [];
    if (p.state) loc.push({ locUsStates: { hasSome: p.state } });
    if (p.country) loc.push({ locCountries: { hasSome: p.country } });
    if (loc.length) and.push(loc.length === 1 ? loc[0] : { OR: loc });
  }
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

// Card grouping (Decision 28): the search result unit is a CARD — one role per (company,
// title) — not a listing row. The 12% residue of same-role/different-location rows is
// dominated by genuine geographic variants (research/dedup-key-simulation.md), so the
// storage rows stay separate and honest; the presentation folds them into one card with
// each variant intact (own id, url, application status). Everything user-facing — total,
// newCount, pagination, facet counts — counts cards, or the "<5% dup" metric would be
// measured against a unit the user never sees.
export interface CardVariant {
  id: number;
  location: string | null;
  locUsStates: string[];
  locCountries: string[];
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
}

export interface Card {
  company: string;
  title: string;
  // Role-level classification, taken from the newest variant (variants[0]); in practice
  // variants of one role classify identically.
  opportunityType: string | null;
  csField: string | null;
  isNew: boolean; // any variant in the NEW window
  variants: CardVariant[]; // newest first; variants[0] is the representative
}

export interface SearchResult {
  total: number; // distinct roles (cards) under current filters
  newCount: number; // cards with a variant in the NEW window
  page: number;
  per: number; // cards per page
  cards: Card[];
  facets: {
    // All counts are card-level (distinct company+title), matching what clicking shows.
    type: Record<string, number>;
    field: Record<string, number>;
    state: Record<string, number>;
    country: Record<string, number>;
    status: Record<string, number>; // includes "none"
  };
}

// One role-group per (company, title): its sort keys, aggregated over matching rows.
export interface RoleGroup {
  company: string; // trimmed — the display form
  title: string; // trimmed
  maxFirstSeen: Date;
  maxPublished: Date | null;
  // Exact stored spellings behind this group. The card key trims like Decision 15's
  // dedupKey() (measured: 7 whitespace-twin cards otherwise, e.g. Graphcore titles with
  // trailing spaces), but SQL groupBy matches exactly — so fetching a group's rows needs
  // every raw spelling it absorbed.
  rawKeys: Array<{ company: string; title: string }>;
}

const roleKey = (company: string, title: string): string => `${company.trim()}::${title.trim()}`;

// Merge SQL's exact-match groups under the trimmed role key, folding sort keys (max wins).
export function mergeGroups(
  raw: Array<{ company: string; title: string; maxFirstSeen: Date; maxPublished: Date | null }>,
): RoleGroup[] {
  const byKey = new Map<string, RoleGroup>();
  for (const g of raw) {
    const k = roleKey(g.company, g.title);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, {
        company: g.company.trim(),
        title: g.title.trim(),
        maxFirstSeen: g.maxFirstSeen,
        maxPublished: g.maxPublished,
        rawKeys: [{ company: g.company, title: g.title }],
      });
      continue;
    }
    existing.rawKeys.push({ company: g.company, title: g.title });
    if (g.maxFirstSeen > existing.maxFirstSeen) existing.maxFirstSeen = g.maxFirstSeen;
    if (g.maxPublished && (!existing.maxPublished || g.maxPublished > existing.maxPublished))
      existing.maxPublished = g.maxPublished;
  }
  return [...byKey.values()];
}

// Card ordering = the old row ordering lifted to groups: a card sorts by its NEWEST
// variant, so a role re-posted in a new city surfaces exactly when the old per-row board
// would have surfaced that posting. Ties (and the company sort) break on company+title so
// pagination slices are stable across requests.
export function sortGroups(groups: RoleGroup[], sort: SearchParams["sort"]): RoleGroup[] {
  const byName = (a: RoleGroup, b: RoleGroup) =>
    a.company.localeCompare(b.company) || a.title.localeCompare(b.title);
  const sorted = [...groups];
  if (sort === "company") return sorted.sort(byName);
  if (sort === "published")
    return sorted.sort((a, b) => {
      if (a.maxPublished === null && b.maxPublished === null) return byName(a, b);
      if (a.maxPublished === null) return 1; // nulls last, same as the SQL sort had
      if (b.maxPublished === null) return -1;
      return b.maxPublished.getTime() - a.maxPublished.getTime() || byName(a, b);
    });
  return sorted.sort(
    (a, b) => b.maxFirstSeen.getTime() - a.maxFirstSeen.getTime() || byName(a, b),
  );
}

// A variant row as fetched, still carrying its grouping key and classification.
export type FetchedVariant = CardVariant & {
  company: string;
  title: string;
  opportunityType: string | null;
  csField: string | null;
};

// Fold fetched rows into cards, PRESERVING pageGroups' order (rows arrive in their own
// order). A group with no rows can't happen (its rows matched the same WHERE moments
// earlier) but is skipped rather than rendered empty if a write races the two queries.
export function assembleCards(pageGroups: RoleGroup[], variants: FetchedVariant[]): Card[] {
  const byKey = new Map<string, FetchedVariant[]>();
  for (const v of variants) {
    const k = roleKey(v.company, v.title);
    const arr = byKey.get(k) ?? [];
    arr.push(v);
    byKey.set(k, arr);
  }
  const cards: Card[] = [];
  for (const g of pageGroups) {
    const rows = byKey.get(roleKey(g.company, g.title));
    if (!rows?.length) continue;
    rows.sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime() || b.id - a.id);
    cards.push({
      company: g.company,
      title: g.title,
      opportunityType: rows[0].opportunityType,
      csField: rows[0].csField,
      isNew: rows.some((r) => r.isNew),
      variants: rows.map(({ company: _c, title: _t, opportunityType: _o, csField: _f, ...v }) => v),
    });
  }
  return cards;
}

export async function search(prisma: PrismaClient, p: SearchParams): Promise<SearchResult> {
  const where = buildWhere(p);
  const cutoff = newCutoff();
  const page = p.page ?? 1;
  const per = p.per ?? 50;

  // Pagination happens over GROUPS, not rows — otherwise a role's variants straddle a page
  // boundary and render as two cards on two pages, resurrecting the duplication the cards
  // exist to remove. All group sort keys come back in one groupBy (~1.6k groups at the
  // current 1.8k rows) and sort/slice in memory; same scale stance as facetArrayCounts —
  // revisit only if the corpus grows 100x.
  const [rawGroups, typeTriples, fieldTriples, statusPairs, stateRows, countryRows] =
    await Promise.all([
      prisma.listing.groupBy({
        by: ["company", "title"],
        where,
        _max: { firstSeenAt: true, publishedAt: true },
      }),
      // Facet counts are distinct (company, title) per facet value: each groupBy result
      // row IS one distinct (value, role) triple, so counting rows per value in JS gives
      // the card count a click on that chip would produce.
      prisma.listing.groupBy({ by: ["opportunityType", "company", "title"], where: buildWhere(p, "type") }),
      prisma.listing.groupBy({ by: ["csField", "company", "title"], where: buildWhere(p, "field") }),
      // Status counts need the join; groupBy can't reach across it, so distinct-select per
      // status. A role whose variants hold different statuses counts once under EACH — the
      // chip count matches the cards that clicking it renders.
      Promise.all(
        [...ALL_STATUSES, "none"].map(async (s) => {
          const w = buildWhere(p, "status");
          const pairs = await prisma.listing.findMany({
            where: s === "none" ? { AND: [w, { application: null }] } : { AND: [w, { application: { status: s as never } }] },
            select: { company: true, title: true },
            distinct: ["company", "title"],
          });
          // DB-distinct is exact-match; fold whitespace twins under the trimmed role key.
          return [s, new Set(pairs.map((r) => `${r.company.trim()}::${r.title.trim()}`)).size] as const;
        }),
      ),
      // Array facets: groupBy can't unnest arrays — raw SQL is the honest tool here.
      facetArrayCounts(prisma, buildWhere(p, "state"), "loc_us_states"),
      facetArrayCounts(prisma, buildWhere(p, "country"), "loc_countries"),
    ]);

  const groups = mergeGroups(
    rawGroups.map((g) => ({
      company: g.company,
      title: g.title,
      // _max is typed nullable but a group always has ≥1 row; epoch fallback keeps TS honest.
      maxFirstSeen: g._max.firstSeenAt ?? new Date(0),
      maxPublished: g._max.publishedAt,
    })),
  );
  const sorted = sortGroups(groups, p.sort);
  const pageGroups = sorted.slice((page - 1) * per, page * per);

  // Fetch the page's variant rows under the SAME where: a card shows only the variants
  // that match the current filters (state=NY shows Palantir's NY posting on the card, not
  // its CA sibling — the card matched because of NY). rawKeys, not the trimmed names —
  // the DB rows only match their exact stored spellings.
  const rows = pageGroups.length
    ? await prisma.listing.findMany({
        where: { AND: [where, { OR: pageGroups.flatMap((g) => g.rawKeys) }] },
        select: {
          id: true, company: true, title: true, location: true,
          locUsStates: true, locCountries: true,
          opportunityType: true, csField: true,
          gradYearMin: true, gradYearMax: true, citizenshipStatus: true, degreeStatus: true,
          url: true, firstSeenAt: true, publishedAt: true, applicationDeadline: true,
          application: { select: { status: true, note: true } },
        },
      })
    : [];

  const cards = assembleCards(
    pageGroups,
    rows.map((r) => ({
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
  );

  // Roles per facet value, distinct under the same TRIMMED key the cards group by.
  const countRoles = (
    triples: Array<{ company: string; title: string } & Record<string, unknown>>,
    key: string,
  ): Record<string, number> => {
    const seen = new Set<string>();
    const out: Record<string, number> = {};
    for (const t of triples) {
      const v = t[key];
      if (typeof v !== "string") continue;
      const k = `${v}::${roleKey(t.company, t.title)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };

  return {
    total: groups.length,
    newCount: groups.filter((g) => g.maxFirstSeen >= cutoff).length,
    page,
    per,
    cards,
    facets: {
      type: countRoles(typeTriples, "opportunityType"),
      field: countRoles(fieldTriples, "csField"),
      state: stateRows,
      country: countryRows,
      status: Object.fromEntries(statusPairs),
    },
  };
}

// Count CARDS per array element (e.g. per US state) under a WHERE. Prisma's groupBy can't
// unnest scalar lists, so this routes the same WHERE through findMany for ids (keeping the
// filter logic in exactly one place) and unnests in SQL over that id set. DISTINCT
// (company, title) makes these card-level like every other facet: Palantir's 3 D.C.
// postings of one role count D.C. once. At 1.8k rows the id-list roundtrip is noise;
// revisit only if the corpus grows 100x.
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
    SELECT unnest(${col}) AS v, count(DISTINCT (btrim(company), btrim(title))) AS c
    FROM listings WHERE id IN (${idList})
    GROUP BY v ORDER BY c DESC`;
  return Object.fromEntries(rows.map((r) => [r.v, Number(r.c)]));
}
