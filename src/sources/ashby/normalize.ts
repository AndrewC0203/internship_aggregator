import type { EmploymentType, WorkplaceType, CompInterval } from "@prisma/client";
import type {
  RawJob,
  NormalizedListing,
  NormalizeContext,
} from "../../pipeline/types.js";
import { prettifyCompanySlug } from "../company-slug.js";

// Shape of an Ashby posting (GET /posting-api/job-board/:name?includeCompensation=true) —
// verified live against three boards (Ramp/Notion/OpenAI, 2026-09-08), not docs alone. See
// __fixtures__/ashby.jobs.sample.json for captured samples and research/
// ats-field-reference.md for the full field table.
interface AshbyPosting {
  id: string;
  title: string;
  department?: string | null;
  team?: string | null;
  employmentType?: string | null; // "FullTime" | "PartTime" | "Intern" | "Contract" | "Temporary"
  location?: string | null; // flat primary-location string, e.g. "San Francisco, California"
  publishedAt: string; // ISO-8601 — unlike Lever's epoch-milliseconds createdAt
  isListed: boolean;
  isRemote?: boolean;
  workplaceType?: string | null; // "OnSite" | "Remote" | "Hybrid"
  jobUrl: string;
  applyUrl: string;
  descriptionHtml: string;
  descriptionPlain: string;
  // Present only with includeCompensation=true — and even then a board that never opted
  // into public comp returns a HOLLOW object (empty tiers/components, null summaries), so
  // every read below is optional. summaryComponents aggregates across tiers; the Salary
  // component is the one carrying minValue/maxValue money.
  compensation?: {
    summaryComponents?: Array<{
      compensationType?: string | null; // "Salary" | "EquityPercentage" | "EquityCashValue" | ...
      interval?: string | null; // "1 YEAR" | "1 HOUR" | "NONE" | ...
      currencyCode?: string | null;
      minValue?: number | null;
      maxValue?: number | null;
    }> | null;
  } | null;
}

// Ashby's employmentType IS a fixed enum (unlike Lever's free-text commitment) — these five
// values are the documented set. An unknown value still falls through to null rather than
// throwing: employmentType is enrichment, not a gate.
const EMPLOYMENT_TYPE_MAP: Record<string, EmploymentType> = {
  fulltime: "full_time",
  parttime: "part_time",
  intern: "intern",
  contract: "contract",
  temporary: "temporary",
};

const WORKPLACE_TYPE_MAP: Record<string, WorkplaceType> = {
  onsite: "onsite",
  remote: "remote",
  hybrid: "hybrid",
};

// Observed live: "1 YEAR" and "1 HOUR". "1 MONTH"/"ONE_TIME" are guesses from the same
// vocabulary; anything unmapped falls to null rather than trusting the guess (same posture
// as Lever's mapCompInterval).
const COMP_INTERVAL_MAP: Record<string, CompInterval> = {
  "1 year": "yearly",
  "1 month": "monthly",
  "1 hour": "hourly",
  "one_time": "one_time",
  "one time": "one_time",
};

function mapEmploymentType(value: string | null | undefined): EmploymentType | null {
  if (!value) return null;
  return EMPLOYMENT_TYPE_MAP[value.trim().toLowerCase()] ?? null;
}

function mapWorkplaceType(job: AshbyPosting): WorkplaceType | null {
  const mapped = job.workplaceType
    ? (WORKPLACE_TYPE_MAP[job.workplaceType.trim().toLowerCase()] ?? null)
    : null;
  if (mapped) return mapped;
  // workplaceType was present on every live-sampled job, but it's not in Ashby's oldest
  // payload versions — isRemote is, so use it as the fallback. isRemote:false only means
  // "not remote" (could be onsite OR hybrid), so it maps to null, not "onsite".
  return job.isRemote ? "remote" : null;
}

// Pull comp from the Salary summary component. Selection is by compensationType, NEVER by
// interval: equity components (e.g. "EquityCashValue") also carry interval "1 YEAR" with
// null min/max, so keying on interval would surface a valueless equity row as the comp.
function mapCompensation(job: AshbyPosting): {
  compMin: number | null;
  compMax: number | null;
  compCurrency: string | null;
  compInterval: CompInterval | null;
} {
  const salary = job.compensation?.summaryComponents?.find(
    (c) => c.compensationType === "Salary",
  );
  return {
    compMin: salary?.minValue ?? null,
    compMax: salary?.maxValue ?? null,
    compCurrency: salary?.currencyCode ?? null,
    compInterval: mapCompInterval(salary?.interval),
  };
}

function mapCompInterval(interval: string | null | undefined): CompInterval | null {
  if (!interval) return null;
  return COMP_INTERVAL_MAP[interval.trim().toLowerCase()] ?? null;
}

// Pure function: Ashby raw posting -> NormalizedListing, or null to drop the job. No I/O —
// unit-testable against the fixture.
export function normalizeAshby(
  raw: RawJob,
  ctx: NormalizeContext,
): NormalizedListing | null {
  const job = raw as AshbyPosting;

  // Same as Lever: one board = one company, and the payload never states it. ctx.company is
  // the learned name from a prior crawl (Decision 22's cache) or the raw slug on a first
  // crawl; prettifyCompanySlug is idempotent against an already-clean learned name. Missing
  // entirely -> drop rather than guess.
  const rawCompany = ctx.company?.trim();
  if (!rawCompany) {
    return null;
  }
  const company = prettifyCompanySlug(rawCompany);

  // The posting-api only returns listed jobs in practice (every live-sampled job had
  // isListed:true), but the field exists precisely to mark unlisted ones — if one ever
  // appears, it must not enter the hub. Dropping it here also lets the delist stage treat
  // it as absent from the board, which retires any previously-stored row for it.
  if (job.isListed === false) {
    return null;
  }

  return {
    source: "ashby",
    sourceExternalId: job.id,
    company,
    title: job.title,

    descriptionHtml: job.descriptionHtml ?? "",
    descriptionPlain: job.descriptionPlain ?? "",

    location: job.location ?? null,
    department: job.department ?? null,

    employmentType: mapEmploymentType(job.employmentType),
    workplaceType: mapWorkplaceType(job),

    ...mapCompensation(job),

    // ISO-8601 string, unlike Lever's epoch-ms — Date parses it directly.
    publishedAt: new Date(job.publishedAt),
    applicationDeadline: null, // not present on Ashby's public posting object

    // Posting page, matching Greenhouse's absolute_url / Lever's hostedUrl semantic —
    // deliberately jobUrl, not applyUrl (the application form).
    url: job.jobUrl,

    duplicateKeys: [], // dedup.ts (Decision 15) is the only stage that ever populates this
  };
}
