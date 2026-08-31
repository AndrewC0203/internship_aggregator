import type { EmploymentType, WorkplaceType, CompInterval } from "@prisma/client";
import type {
  RawJob,
  NormalizedListing,
  NormalizeContext,
} from "../../pipeline/types.js";
import { prettifyCompanySlug } from "../company-slug.js";

// Shape of a Lever posting (GET /v0/postings/:site?mode=json) — verified against a live
// board (Palantir, 2026-08-31), not docs alone. See __fixtures__/palantir.postings.sample.json
// for a captured sample and research/ats-field-reference.md for the full field table.
interface LeverPosting {
  id: string;
  text: string;
  categories: {
    commitment?: string | null;
    location?: string | null;
    department?: string | null;
    team?: string | null;
    allLocations?: string[] | null;
  };
  country?: string | null;
  description: string; // HTML — NOT entity-double-encoded, unlike Greenhouse's `content`
  descriptionPlain: string; // Lever pre-strips this; no htmlToPlain() round-trip needed
  hostedUrl: string;
  applyUrl: string;
  workplaceType?: string | null;
  // UNVERIFIED shape: no job in the live sample had salaryRange populated (it's opt-in per
  // company), so `interval`'s actual string values are a best guess from Lever's product
  // vocabulary, not observed data. mapCompInterval() falls through to null on anything that
  // doesn't match rather than trusting the guess blindly.
  salaryRange?: {
    min?: number | null;
    max?: number | null;
    currency?: string | null;
    interval?: string | null;
  } | null;
  createdAt: number; // epoch MILLISECONDS
}

// `categories.commitment` is free text the posting company typed into their own Lever admin,
// not a fixed enum — the live sample (Palantir) used "Fixed-Term" and "Scholarship" for
// non-full-time roles, neither of which appears in any Lever doc. An unmapped value falls
// through to null rather than throwing: employmentType is enrichment, not a gate —
// opportunityType still gets classified downstream from title/description either way.
const COMMITMENT_TO_EMPLOYMENT_TYPE: Record<string, EmploymentType> = {
  "full-time": "full_time",
  "part-time": "part_time",
  internship: "intern",
  intern: "intern",
  contract: "contract",
  temporary: "temporary",
  "fixed-term": "temporary",
};

const WORKPLACE_TYPE_MAP: Record<string, WorkplaceType> = {
  "on-site": "onsite",
  onsite: "onsite",
  remote: "remote",
  hybrid: "hybrid",
  // "unspecified" (a documented possible value) intentionally has no entry -> falls to null.
};

const COMP_INTERVAL_MAP: Record<string, CompInterval> = {
  hour: "hourly",
  hourly: "hourly",
  month: "monthly",
  monthly: "monthly",
  year: "yearly",
  yearly: "yearly",
  annual: "yearly",
  "one-time": "one_time",
  "one_time": "one_time",
};

function mapEmploymentType(commitment: string | null | undefined): EmploymentType | null {
  if (!commitment) return null;
  return COMMITMENT_TO_EMPLOYMENT_TYPE[commitment.trim().toLowerCase()] ?? null;
}

function mapWorkplaceType(workplaceType: string | null | undefined): WorkplaceType | null {
  if (!workplaceType) return null;
  return WORKPLACE_TYPE_MAP[workplaceType.trim().toLowerCase()] ?? null;
}

function mapCompInterval(interval: string | null | undefined): CompInterval | null {
  if (!interval) return null;
  return COMP_INTERVAL_MAP[interval.trim().toLowerCase()] ?? null;
}

// Pure function: Lever raw posting -> NormalizedListing, or null to drop the job. No I/O —
// unit-testable against the fixture.
export function normalizeLever(
  raw: RawJob,
  ctx: NormalizeContext,
): NormalizedListing | null {
  const job = raw as LeverPosting;

  // Lever's posting object never carries a company field — one board = one company, so it's
  // implicit in which board you queried, not payload data (confirmed: absent from every job
  // in the live sample). ctx.company is the orchestrator's best-known signal: the learned
  // name from a prior crawl (Decision 22's cache) or, on a board's first-ever crawl, the raw
  // slug. Either way it's run through prettifyCompanySlug (idempotent against an
  // already-clean learned name — see that function's own comment). Missing entirely should
  // not happen (the orchestrator always forwards at least the token) — drop rather than
  // guess, matching normalizeGreenhouse's missing-company behavior.
  const rawCompany = ctx.company?.trim();
  if (!rawCompany) {
    return null;
  }
  const company = prettifyCompanySlug(rawCompany);

  return {
    source: "lever",
    sourceExternalId: job.id,
    company,
    title: job.text,

    descriptionHtml: job.description ?? "",
    descriptionPlain: job.descriptionPlain ?? "",

    location: job.categories?.location ?? null,
    department: job.categories?.department ?? null,

    employmentType: mapEmploymentType(job.categories?.commitment),
    workplaceType: mapWorkplaceType(job.workplaceType),

    compMin: job.salaryRange?.min ?? null,
    compMax: job.salaryRange?.max ?? null,
    compCurrency: job.salaryRange?.currency ?? null,
    compInterval: mapCompInterval(job.salaryRange?.interval),

    // Lever ships this as epoch MILLISECONDS, not seconds — `new Date(raw.createdAt * 1000)`
    // would be the classic footgun here; verified against the live sample.
    publishedAt: new Date(job.createdAt),
    applicationDeadline: null, // not present on Lever's public postings object

    // Posting page, matching normalizeGreenhouse's absolute_url semantic — deliberately
    // hostedUrl, not applyUrl (the application form), so "view listing" behaves the same
    // across sources.
    url: job.hostedUrl,

    duplicateKeys: [], // dedup.ts (Decision 15) is the only stage that ever populates this
  };
}
