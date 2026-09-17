import { Prisma } from "@prisma/client";
import { curatedSelectiveCompanies } from "./labels.js";

// Questionnaire (spec table). Hard answers become SQL conditions in the ranking query; soft
// answers (types + target fields + interests) also merge into the profile's Seeking: section
// via canonical.ts. INVARIANT for every hard filter here: nulls are KEPT and badged at
// render — filters exclude only explicit contradictions, never absence-of-statement.

export interface Questionnaire {
  gradYearMin: number | null;
  gradYearMax: number | null;
  // Three separate booleans (spec: "not one conflated status"); null = unanswered.
  usCitizen: boolean | null;
  workAuthorized: boolean | null;
  needsSponsorship: boolean | null; // now OR later — the OPT case lives here
  locStates: string[];
  locCountries: string[];
  remoteOk: boolean;
  types: string[]; // opportunity types wanted (hard multi-select)
  targetFields: Array<{ field: string; mustHave: boolean }>; // soft; mustHave promotes to hard
  interests: string; // free-text, soft only
  // Ported from search.ts's /search facets. Parsed/persisted like any other field here, but
  // the /profile UI never exposes a control for them — /foryou's page sets them per-request
  // instead (see rank.ts recommend()'s overrides), so toggling a filter chip there never
  // touches the approved profile's stored answers or bumps its revision.
  workplaceTypes: string[]; // onsite/remote/hybrid; hard multi-select, same nulls-kept rule
  curatedOnly: boolean; // restrict to data/company-tiers.json's curated list (Decision 32)
}

const ALL_TYPES = ["internship", "co_op", "fellowship", "new_grad", "research", "part_time"];
const ALL_FIELDS = [
  "swe", "ml_ai", "data", "quant", "security",
  "hardware_embedded", "devops_infra", "it", "product", "other",
];
const ALL_WORKPLACE = ["onsite", "remote", "hybrid"];

export function defaultQuestionnaire(): Questionnaire {
  return {
    gradYearMin: null,
    gradYearMax: null,
    usCitizen: null,
    workAuthorized: null,
    needsSponsorship: null,
    locStates: [],
    locCountries: [],
    remoteOk: true,
    types: [],
    targetFields: [],
    interests: "",
    workplaceTypes: [],
    curatedOnly: false,
  };
}

// Boundary parsing, same posture as search.ts parseParams: unknown enum values and junk
// types are DROPPED, never errored — a stale UI can't corrupt the stored questionnaire.
export function parseQuestionnaire(raw: unknown): Questionnaire {
  const d = defaultQuestionnaire();
  if (typeof raw !== "object" || raw === null) return d;
  const o = raw as Record<string, unknown>;

  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const year = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 2020 && v <= 2040 ? v : null;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    gradYearMin: year(o.gradYearMin),
    gradYearMax: year(o.gradYearMax),
    usCitizen: bool(o.usCitizen),
    workAuthorized: bool(o.workAuthorized),
    needsSponsorship: bool(o.needsSponsorship),
    locStates: strList(o.locStates).map((s) => s.trim().toUpperCase()).filter(Boolean),
    locCountries: strList(o.locCountries).map((s) => s.trim().toUpperCase()).filter(Boolean),
    remoteOk: typeof o.remoteOk === "boolean" ? o.remoteOk : d.remoteOk,
    types: strList(o.types).filter((t) => ALL_TYPES.includes(t)),
    targetFields: Array.isArray(o.targetFields)
      ? o.targetFields
          .filter(
            (f): f is { field: string; mustHave: unknown } =>
              typeof f === "object" && f !== null &&
              typeof (f as { field?: unknown }).field === "string",
          )
          .filter((f) => ALL_FIELDS.includes(f.field))
          .map((f) => ({ field: f.field, mustHave: f.mustHave === true }))
      : [],
    interests: typeof o.interests === "string" ? o.interests : "",
    workplaceTypes: strList(o.workplaceTypes).filter((w) => ALL_WORKPLACE.includes(w)),
    curatedOnly: o.curatedOnly === true,
  };
}

// Work-auth exclusion mapping (spec, verbatim):
//   listing us_citizen_required  -> excluded unless citizen = yes
//   listing no_sponsorship       -> excluded if needs-sponsorship (now or later) = yes —
//                                   current authorization alone is NOT enough (OPT case)
//   sponsorship_available/unknown -> never excluded (unknown gets a badge, render-side)
// Unanswered (null) booleans exclude nothing: only explicit contradictions filter.
export function workAuthExclusions(q: Questionnaire): {
  excludeCitizenRequired: boolean;
  excludeNoSponsorship: boolean;
} {
  return {
    excludeCitizenRequired: q.usCitizen === false,
    excludeNoSponsorship: q.needsSponsorship === true,
  };
}

// The hard filters as SQL fragments, AND-ed into the ranking query by rank.ts. Every
// condition keeps NULL listing values (badged at render), matching the spec invariant.
export function hardConditions(q: Questionnaire): Prisma.Sql[] {
  const conds: Prisma.Sql[] = [];

  const ex = workAuthExclusions(q);
  const excluded: string[] = [];
  if (ex.excludeCitizenRequired) excluded.push("us_citizen_required");
  if (ex.excludeNoSponsorship) excluded.push("no_sponsorship");
  if (excluded.length) {
    // ::text comparison sidesteps enum-array binding; the enum's values are a superset of
    // `excluded` by construction (the strings above mirror CitizenshipStatus).
    conds.push(
      Prisma.sql`(citizenship_status IS NULL OR citizenship_status::text <> ALL(${excluded}))`,
    );
  }

  if (q.gradYearMin !== null && q.gradYearMax !== null) {
    // Window OVERLAP, nulls kept — same class-year semantics as search.ts buildWhere.
    conds.push(
      Prisma.sql`(grad_year_min IS NULL OR grad_year_min <= ${q.gradYearMax})
                 AND (grad_year_max IS NULL OR grad_year_max >= ${q.gradYearMin})`,
    );
  }

  if (q.types.length) {
    conds.push(Prisma.sql`(opportunity_type IS NULL OR opportunity_type::text = ANY(${q.types}))`);
  }

  const musts = q.targetFields.filter((f) => f.mustHave).map((f) => f.field);
  if (musts.length) {
    // Multiple must-haves = OR (ANY does that); non-must-have fields stay soft (Seeking text).
    conds.push(Prisma.sql`(cs_field IS NULL OR cs_field::text = ANY(${musts}))`);
  }

  if (q.workplaceTypes.length) {
    conds.push(Prisma.sql`(workplace_type IS NULL OR workplace_type::text = ANY(${q.workplaceTypes}))`);
  }

  if (q.curatedOnly) {
    // Raw SQL, so lower(trim(...)) is available directly — unlike search.ts's buildWhere,
    // which builds a Prisma.ListingWhereInput and has to fall back to an OR of per-value
    // case-insensitive `equals` for the same list (Prisma's typed API has no ANY() escape).
    conds.push(Prisma.sql`lower(trim(company)) = ANY(${curatedSelectiveCompanies()})`);
  }

  if (q.locStates.length || q.locCountries.length) {
    // Location facet overlap; unresolved rows (both arrays empty) are kept + badged.
    // Remote passes ONLY under the country rule (spec): a remote listing that STATES
    // countries must overlap the user's countries — user countries ∪ US implied by any
    // state selection. A remote listing with no stated countries is kept.
    const userCountries = [
      ...new Set([...q.locCountries, ...(q.locStates.length ? ["US"] : [])]),
    ];
    conds.push(
      Prisma.sql`(
        (loc_us_states = '{}' AND loc_countries = '{}')
        OR loc_us_states && ${q.locStates}::text[]
        OR loc_countries && ${q.locCountries}::text[]
        OR (${q.remoteOk} AND workplace_type = 'remote'
            AND (loc_countries = '{}' OR loc_countries && ${userCountries}::text[]))
      )`,
    );
  }

  return conds;
}
