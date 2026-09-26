// Search query layer (Decision 20). One function builds the WHERE from parsed params; both
// the JSON API and the SSR page call it, so there is never a "page query" and an "API query"
// drifting apart — the API the UI renders from is the API the project exposes.
import { Prisma, PrismaClient } from "@prisma/client";
import { curatedSelectiveCompanies } from "../recommend/labels.js";
import { toVectorLiteral } from "../model/ollama.js";
import { EMBED_MODEL, TEMPLATE_VERSION } from "../recommend/config.js";
import { blendScore, freshness, band as scoreBand } from "../recommend/score.js";
import { loadActiveProfile } from "../recommend/profile.js";

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
  workplace?: string[]; // workplace_type values (onsite/remote/hybrid)
  source?: string[]; // ingestion Source values (greenhouse/lever/ashby/simplify)
  // Curated-list-only toggle (Decision 32's annotation list, promoted to a filter here).
  // NOT a selectivity judgment on the rest of the corpus — see company-tiers.json's own
  // "annotates, never filters" note. Label this in the UI as "curated list", not "selective".
  selective?: boolean;
  newOnly?: boolean; // only rows inside the NEW window
  // "fit" only has an effect when the caller actually has a profile/vector to rank
  // against (see rankedSearch) — parseParams accepts it unconditionally, same posture
  // as every other enum here (a stale UI value is dropped, never errored).
  sort?: "first_seen" | "published" | "company" | "deadline" | "fit";
  page?: number; // 1-based
  per?: number;
}

const ALL_TYPES = ["internship", "co_op", "fellowship", "new_grad", "research", "part_time"];
const ALL_FIELDS = ["swe", "ml_ai", "data", "quant", "security", "hardware_embedded", "devops_infra", "it", "product", "other"];
const ALL_STATUSES = ["saved", "applied", "interviewing", "offer", "rejected"];
const ALL_WORKPLACE = ["onsite", "remote", "hybrid"];
// "other" is in the enum but has no rows and no UI chip; accepted here anyway so a listing
// under it would stay reachable rather than unfilterable.
const ALL_SOURCES = ["greenhouse", "lever", "ashby", "simplify", "other"];

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
  // Integers only: Number("2.5") survives `|| fallback` and Math.max, and pre-guard the
  // pager rendered "PAGE 2.5" with a PREV link to ?page=1.5; ?page=Infinity looped forever
  // (Infinity - 1 === Infinity). Junk falls to the default, same posture as the enum params.
  const int = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  };
  const page = Math.max(1, int(raw.page) ?? 1);
  // Deliberately left undefined (not defaulted to "first_seen") when absent/invalid —
  // runSearch() is the one place that knows whether ranking is available, and needs to
  // tell "no sort chosen" apart from "explicitly chose first_seen" to pick the right
  // default (fit vs first_seen). Defaulting here would make that distinction impossible.
  const sort =
    raw.sort === "first_seen" || raw.sort === "published" || raw.sort === "company" ||
    raw.sort === "deadline" || raw.sort === "fit"
      ? raw.sort
      : undefined;
  return {
    q: typeof raw.q === "string" && raw.q.trim() ? raw.q.trim() : undefined,
    type: keep(list(raw.type), ALL_TYPES),
    field: keep(list(raw.field), ALL_FIELDS),
    country: list(raw.country).length ? list(raw.country).map((c) => c.toUpperCase()) : undefined,
    state: list(raw.state).length ? list(raw.state).map((s) => s.toUpperCase()) : undefined,
    gradYear: Number.isInteger(gradYear) && gradYear >= 2020 && gradYear <= 2040 ? gradYear : undefined,
    status: keep(list(raw.status), [...ALL_STATUSES, "none"]),
    workplace: keep(list(raw.workplace), ALL_WORKPLACE),
    source: keep(list(raw.source), ALL_SOURCES),
    selective: raw.selective === "1" || raw.selective === "true",
    newOnly: raw.new === "1" || raw.new === "true",
    sort,
    page,
    per: Math.min(200, Math.max(10, int(raw.per) ?? 50)),
  };
}

export function newCutoff(now = new Date()): Date {
  return new Date(now.getTime() - NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

// Build the WHERE for a param set, optionally omitting one facet's own constraint. The
// omission is what makes rail counts honest faceted-search counts: the "internship (663)"
// count must answer "what would I get if I ALSO clicked this", so a facet's own current
// selection can't constrain its own counts.
export function buildWhere(
  p: SearchParams,
  omit?: "type" | "field" | "country" | "state" | "status" | "workplace" | "source",
): Prisma.ListingWhereInput {
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
  if (p.workplace && omit !== "workplace") and.push({ workplaceType: { in: p.workplace as never[] } });
  if (p.source && omit !== "source") and.push({ source: { in: p.source as never[] } });
  if (p.selective) {
    // Case-insensitive OR over the curated list (Decision 32): the file stores lowercased
    // trimmed names for the badge's Set lookup, but Prisma's `in` can't do per-value case
    // insensitivity, so this is an OR of `equals` checks instead — same short list either way.
    and.push({
      OR: curatedSelectiveCompanies().map((name) => ({
        company: { equals: name, mode: "insensitive" as const },
      })),
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
  // Only present under sort=fit (rankedSearch) — undefined on the chronological path, so
  // render.ts's card() can tell "not ranked" from "ranked, still computing" apart cleanly.
  score?: number;
  band?: "strong" | "good" | "fair";
}

export interface SearchResult {
  total: number; // distinct roles (cards) under current filters
  newCount: number; // cards with a variant in the NEW window
  page: number;
  per: number; // cards per page
  cards: Card[];
  // Only set under sort=fit (rankedSearch): rows matching every OTHER filter but not yet
  // embedded (or embedded under a stale model/template) can't be ranked at all, so they're
  // silently absent from `total` unless surfaced here — same "half-enriched corpus degrades
  // LOUDLY, not silently" rule rank.ts's RecResult.excludedUnenriched already enforces for
  // /foryou. A row count, not a role count, matching that same precedent.
  excludedUnenriched?: number;
  facets: {
    // All counts are card-level (distinct company+title), matching what clicking shows.
    type: Record<string, number>;
    field: Record<string, number>;
    source: Record<string, number>;
    state: Record<string, number>;
    country: Record<string, number>;
    status: Record<string, number>; // includes "none"
    workplace: Record<string, number>;
  };
}

// One role-group per (company, title): its sort keys, aggregated over matching rows.
export interface RoleGroup {
  company: string; // trimmed — the display form
  title: string; // trimmed
  maxFirstSeen: Date;
  maxPublished: Date | null;
  // Soonest stated deadline across the group's variants (min wins, nulls excluded from the
  // min) — a role is "closing soon" if ANY of its postings is, matching how the board
  // already treats isNew (any variant qualifies the whole card).
  minDeadline: Date | null;
  // Exact stored spellings behind this group. The card key trims like Decision 15's
  // dedupKey() (measured: 7 whitespace-twin cards otherwise, e.g. Graphcore titles with
  // trailing spaces), but SQL groupBy matches exactly — so fetching a group's rows needs
  // every raw spelling it absorbed.
  rawKeys: Array<{ company: string; title: string }>;
}

const roleKey = (company: string, title: string): string => `${company.trim()}::${title.trim()}`;

// Merge SQL's exact-match groups under the trimmed role key, folding sort keys (max wins,
// deadline min wins).
export function mergeGroups(
  raw: Array<{
    company: string;
    title: string;
    maxFirstSeen: Date;
    maxPublished: Date | null;
    minDeadline: Date | null;
  }>,
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
        minDeadline: g.minDeadline,
        rawKeys: [{ company: g.company, title: g.title }],
      });
      continue;
    }
    existing.rawKeys.push({ company: g.company, title: g.title });
    if (g.maxFirstSeen > existing.maxFirstSeen) existing.maxFirstSeen = g.maxFirstSeen;
    if (g.maxPublished && (!existing.maxPublished || g.maxPublished > existing.maxPublished))
      existing.maxPublished = g.maxPublished;
    if (g.minDeadline && (!existing.minDeadline || g.minDeadline < existing.minDeadline))
      existing.minDeadline = g.minDeadline;
  }
  return [...byKey.values()];
}

// Card ordering = the old row ordering lifted to groups: a card sorts by its NEWEST
// variant, so a role re-posted in a new city surfaces exactly when the old per-row board
// would have surfaced that posting. Ties (and the company sort) break on company+title so
// pagination slices are stable across requests.
export function sortGroups(
  groups: RoleGroup[],
  sort: SearchParams["sort"],
  now: Date = new Date(),
): RoleGroup[] {
  const byName = (a: RoleGroup, b: RoleGroup) =>
    a.company.localeCompare(b.company) || a.title.localeCompare(b.title);
  const sorted = [...groups];
  if (sort === "company") return sorted.sort(byName);
  if (sort === "deadline") {
    // Three buckets, not a plain ascending sort: an already-passed deadline is stale data
    // (measured live — some is_listed rows carry 2023 deadlines), and a naive date sort
    // would surface those AHEAD of a real 2026 "closes next week" row. "Closing soon" means
    // future-and-soonest first; no-stated-deadline sits in the middle (still open, just
    // unknown urgency — same nulls-kept posture as every other filter here); already-closed
    // sinks last, since it's the least actionable position for a job search.
    const nowMs = now.getTime();
    const bucket = (d: Date | null): 0 | 1 | 2 => (d === null ? 1 : d.getTime() >= nowMs ? 0 : 2);
    return sorted.sort((a, b) => {
      const ba = bucket(a.minDeadline);
      const bb = bucket(b.minDeadline);
      if (ba !== bb) return ba - bb;
      if (ba === 1) return byName(a, b);
      return (a.minDeadline as Date).getTime() - (b.minDeadline as Date).getTime() || byName(a, b);
    });
  }
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

// Roles per facet value, distinct under the same TRIMMED key the cards group by.
function countRoles(
  triples: Array<{ company: string; title: string } & Record<string, unknown>>,
  key: string,
): Record<string, number> {
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
}

// Shared by search() and rankedSearch(): facet counts answer "what would clicking this
// chip do" and depend ONLY on the filter set, never on sort/rank order — computing them
// once here means the ranked path can't drift from the chronological path on what a
// chip's number means, the same reasoning that keeps buildWhere() itself singular.
async function computeFacets(prisma: PrismaClient, p: SearchParams): Promise<SearchResult["facets"]> {
  const [typeTriples, fieldTriples, workplaceTriples, sourceTriples, statusPairs, stateRows, countryRows] =
    await Promise.all([
      prisma.listing.groupBy({ by: ["opportunityType", "company", "title"], where: buildWhere(p, "type") }),
      prisma.listing.groupBy({ by: ["csField", "company", "title"], where: buildWhere(p, "field") }),
      prisma.listing.groupBy({ by: ["workplaceType", "company", "title"], where: buildWhere(p, "workplace") }),
      prisma.listing.groupBy({ by: ["source", "company", "title"], where: buildWhere(p, "source") }),
      Promise.all(
        [...ALL_STATUSES, "none"].map(async (s) => {
          const w = buildWhere(p, "status");
          const pairs = await prisma.listing.findMany({
            where: s === "none" ? { AND: [w, { application: null }] } : { AND: [w, { application: { status: s as never } }] },
            select: { company: true, title: true },
            distinct: ["company", "title"],
          });
          return [s, new Set(pairs.map((r) => `${r.company.trim()}::${r.title.trim()}`)).size] as const;
        }),
      ),
      facetArrayCounts(prisma, buildWhere(p, "state"), "loc_us_states"),
      facetArrayCounts(prisma, buildWhere(p, "country"), "loc_countries"),
    ]);
  return {
    type: countRoles(typeTriples, "opportunityType"),
    field: countRoles(fieldTriples, "csField"),
    workplace: countRoles(workplaceTriples, "workplaceType"),
    source: countRoles(sourceTriples, "source"),
    state: stateRows,
    country: countryRows,
    status: Object.fromEntries(statusPairs),
  };
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
  const [rawGroups, facets] = await Promise.all([
    prisma.listing.groupBy({
      by: ["company", "title"],
      where,
      _max: { firstSeenAt: true, publishedAt: true },
      _min: { applicationDeadline: true },
    }),
    computeFacets(prisma, p),
  ]);

  const groups = mergeGroups(
    rawGroups.map((g) => ({
      company: g.company,
      title: g.title,
      // _max is typed nullable but a group always has ≥1 row; epoch fallback keeps TS honest.
      maxFirstSeen: g._max.firstSeenAt ?? new Date(0),
      maxPublished: g._max.publishedAt,
      minDeadline: g._min.applicationDeadline,
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

  return {
    total: groups.length,
    newCount: groups.filter((g) => g.maxFirstSeen >= cutoff).length,
    page,
    per,
    cards,
    facets,
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

// --- ranked search (Decision 34): rank the board itself by resume fit ---------------------
//
// buildWhere() builds a Prisma.ListingWhereInput; ranking needs raw SQL (cosine distance
// against the Unsupported("vector") column Prisma can't see at all — same constraint that
// shaped rank.ts). This is a SEPARATE translation of SearchParams into Prisma.Sql, not a
// wrapper around buildWhere — the two are kept in sync by contract (searchParamsToSql.test.ts
// asserts row-for-row parity against buildWhere for a battery of param combinations), not by
// sharing code, because there is no single representation both a typed Prisma query and a
// raw SQL template can build from.
export function searchParamsToSql(p: SearchParams): Prisma.Sql[] {
  const conds: Prisma.Sql[] = [Prisma.sql`is_listed`];
  if (p.q) {
    const needle = `%${p.q}%`;
    conds.push(Prisma.sql`(title ILIKE ${needle} OR company ILIKE ${needle})`);
  }
  if (p.type) conds.push(Prisma.sql`opportunity_type::text = ANY(${p.type})`);
  if (p.field) conds.push(Prisma.sql`cs_field::text = ANY(${p.field})`);
  if (p.state || p.country) {
    const loc: Prisma.Sql[] = [];
    if (p.state) loc.push(Prisma.sql`loc_us_states && ${p.state}::text[]`);
    if (p.country) loc.push(Prisma.sql`loc_countries && ${p.country}::text[]`);
    conds.push(loc.length === 1 ? loc[0] : Prisma.sql`(${Prisma.join(loc, " OR ")})`);
  }
  if (p.gradYear) {
    // Same class-year compatibility as buildWhere: matches when the stated window
    // includes the year OR the listing states no window at all.
    conds.push(Prisma.sql`(grad_year_min IS NULL OR grad_year_min <= ${p.gradYear})
                          AND (grad_year_max IS NULL OR grad_year_max >= ${p.gradYear})`);
  }
  if (p.workplace) conds.push(Prisma.sql`workplace_type::text = ANY(${p.workplace})`);
  if (p.source) conds.push(Prisma.sql`source::text = ANY(${p.source})`);
  if (p.selective) conds.push(Prisma.sql`lower(trim(company)) = ANY(${curatedSelectiveCompanies()})`);
  if (p.newOnly) conds.push(Prisma.sql`first_seen_at >= ${newCutoff()}`);
  if (p.status) {
    const wantNone = p.status.includes("none");
    const real = p.status.filter((s) => s !== "none");
    const parts: Prisma.Sql[] = [];
    if (real.length) parts.push(Prisma.sql`a.status::text = ANY(${real})`);
    if (wantNone) parts.push(Prisma.sql`a.status IS NULL`);
    if (parts.length) conds.push(Prisma.sql`(${Prisma.join(parts, " OR ")})`);
  }
  return conds;
}

export interface RankedFetchedVariant extends FetchedVariant {
  score: number;
}

export interface RankedRoleGroup {
  company: string;
  title: string;
  opportunityType: string | null;
  csField: string | null;
  bestScore: number;
  variants: RankedFetchedVariant[]; // unsorted until finalized below
}

// Groups already-scored rows into role cards in ONE pass — unlike search()'s two-phase
// DB-side groupBy-then-page-fetch (an optimization for chronological pagination that ranked
// mode doesn't need: fetching every eligible row is already the cost of computing cosine
// similarity against all of them, same "corpus is ~2k rows" argument rank.ts's groupByRole
// relies on). rank.ts's OWN groupByRole can't be reused here — it collapses variants down to
// bare location strings, discarding the per-variant status/deadline/id detail the board's
// SET controls need for every row, not just the representative.
export function groupRanked(rows: RankedFetchedVariant[]): RankedRoleGroup[] {
  const byKey = new Map<string, RankedRoleGroup>();
  for (const r of rows) {
    const key = roleKey(r.company, r.title);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        company: r.company.trim(),
        title: r.title.trim(),
        opportunityType: r.opportunityType,
        csField: r.csField,
        bestScore: r.score,
        variants: [r],
      });
    } else {
      existing.variants.push(r);
      if (r.score > existing.bestScore) existing.bestScore = r.score;
    }
  }
  return [...byKey.values()];
}

// Rank the board by fit instead of recency. `vector` is whatever the caller resolved
// (freshly-pasted draft or a previously-approved profile — see draftCache.ts / profile.ts);
// this function only cares that it's a vector in the current embedding space.
export async function rankedSearch(
  prisma: PrismaClient,
  p: SearchParams,
  vector: number[],
): Promise<SearchResult> {
  const cutoff = newCutoff();
  const page = p.page ?? 1;
  const per = p.per ?? 50;
  const vec = toVectorLiteral(vector);
  const whereSql = Prisma.join(searchParamsToSql(p), " AND ");

  // The usability gate, spelled out exactly like rank.ts's rankAgainst(): a signature can
  // save while its embed fails, and a model/template mismatch means the vector lives in a
  // different space — both checks, every time a query touches embedding.
  const usable = Prisma.sql`l.embedding IS NOT NULL AND l.embedding_model = ${EMBED_MODEL}
    AND l.template_version = ${TEMPLATE_VERSION}`;

  const [rows, excludedRows, facets] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        id: number; company: string; title: string; location: string | null;
        loc_us_states: string[]; loc_countries: string[];
        opportunity_type: string | null; cs_field: string | null;
        grad_year_min: number | null; grad_year_max: number | null;
        citizenship_status: string | null; degree_status: string | null;
        url: string; first_seen_at: Date; published_at: Date | null;
        application_deadline: Date | null;
        app_status: string | null; app_note: string | null;
        similarity: number;
      }>
    >`
      SELECT l.id, l.company, l.title, l.location, l.loc_us_states, l.loc_countries,
             l.opportunity_type, l.cs_field, l.grad_year_min, l.grad_year_max,
             l.citizenship_status, l.degree_status, l.url, l.first_seen_at, l.published_at,
             l.application_deadline, a.status AS app_status, a.note AS app_note,
             1 - (l.embedding <=> ${vec}::vector) AS similarity
      FROM listings l
      LEFT JOIN applications a ON a.listing_id = l.id
      WHERE ${whereSql} AND ${usable}`,
    // The gate's complement under the SAME filters: rows this view's other facets would
    // include, but ranking can't — the count that makes a half-enriched corpus fail loud
    // (an explicit "N not yet enriched") instead of quietly showing fewer roles.
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM listings l
      LEFT JOIN applications a ON a.listing_id = l.id
      WHERE ${whereSql} AND NOT (${usable})`,
    computeFacets(prisma, p),
  ]);

  const now = new Date();
  const scored: RankedFetchedVariant[] = rows.map((r) => ({
    id: r.id,
    company: r.company,
    title: r.title,
    opportunityType: r.opportunity_type,
    csField: r.cs_field,
    location: r.location,
    locUsStates: r.loc_us_states,
    locCountries: r.loc_countries,
    gradYearMin: r.grad_year_min,
    gradYearMax: r.grad_year_max,
    citizenshipStatus: r.citizenship_status,
    degreeStatus: r.degree_status,
    url: r.url,
    firstSeenAt: r.first_seen_at,
    publishedAt: r.published_at,
    applicationDeadline: r.application_deadline,
    isNew: r.first_seen_at >= cutoff,
    status: r.app_status,
    note: r.app_note,
    score: blendScore(r.similarity, freshness(r.published_at, r.first_seen_at, now)),
  }));

  const groups = groupRanked(scored).sort(
    (a, b) =>
      b.bestScore - a.bestScore ||
      a.company.localeCompare(b.company) ||
      a.title.localeCompare(b.title),
  );
  const pageGroups = groups.slice((page - 1) * per, page * per);
  const total = groups.length;

  const cards: Card[] = pageGroups.map((g, i) => {
    const variants = [...g.variants].sort(
      (a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime() || b.id - a.id,
    );
    const rank = (page - 1) * per + i;
    return {
      company: g.company,
      title: g.title,
      opportunityType: variants[0].opportunityType,
      csField: variants[0].csField,
      isNew: variants.some((v) => v.isNew),
      variants: variants.map(({ score: _s, ...v }) => v),
      score: g.bestScore,
      band: scoreBand(rank, total),
    };
  });

  return {
    total,
    newCount: groups.filter((g) => g.variants.some((v) => v.isNew)).length,
    page,
    per,
    cards,
    facets,
    excludedUnenriched: Number(excludedRows[0]?.n ?? 0n),
  };
}

export interface RunSearchResult {
  params: SearchParams; // sort resolved to a concrete value — never undefined past here
  result: SearchResult;
  // "draft" = paste-and-go, not yet saved (render.ts shows a SAVE control); "approved" =
  // ranking by the persisted profile, nothing pending; "none" = no FIT option at all;
  // "stale" = approved profile exists but its vector predates the current embedding
  // config — can't rank (same downgrade as none) but MUST look different: the remediation
  // is "re-approve on /profile", not "set up a profile".
  profileState: "draft" | "approved" | "stale" | "none";
}

// The single entry point both / (SSR) and /api/search call — deciding WHICH engine runs
// (plain chronological vs cosine-ranked) lives here exactly once, so the two routes can't
// diverge on when ranking kicks in. `sort` resolution: an explicit choice always wins;
// otherwise default to "fit" once a profile/draft exists, "first_seen" otherwise — an
// explicit `sort=fit` with no active profile downgrades to first_seen rather than
// erroring, same "stale UI value, don't crash" posture as parseParams' own enum guards.
export async function runSearch(prisma: PrismaClient, params: SearchParams): Promise<RunSearchResult> {
  const active = await loadActiveProfile(prisma);
  // A stale profile can't rank (its vector predates the current config), so it downgrades
  // like "none" — but profileState carries "stale" through so the UI shows the re-approve
  // remediation instead of silently pretending no profile exists.
  const rankable = active.state === "draft" || active.state === "approved" ? active : null;
  let sort = params.sort ?? (rankable ? "fit" : "first_seen");
  if (sort === "fit" && !rankable) sort = "first_seen";
  const effective: SearchParams = { ...params, sort };

  const result =
    sort === "fit" && rankable
      ? await rankedSearch(prisma, effective, rankable.vector)
      : await search(prisma, effective);

  return { params: effective, result, profileState: active.state };
}
