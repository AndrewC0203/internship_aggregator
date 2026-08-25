import type { OpportunityType, CitizenshipStatus } from "@prisma/client";
import type { NormalizedListing } from "../pipeline/types.js";
import { chatJson } from "./ollama.js";

// The local-model prompts + output schemas for the two passes (Decision 12). Kept together so
// the prompt and the JSON schema it must satisfy live next to each other. Enum lists mirror
// the Prisma enums exactly — if those change, change these too.

const OPPORTUNITY_TYPES = [
  "internship",
  "co_op",
  "fellowship",
  "new_grad",
  "research",
  "part_time",
] as const;

const CITIZENSHIP = [
  "us_citizen_required",
  "no_sponsorship",
  "sponsorship_available",
  "unknown",
] as const;

// Bound the description we send so a pathologically long posting can't blow up the context /
// latency. 6000 chars is comfortably enough for grad-year / visa / deadline signals.
const MAX_DESC_CHARS = 6000;
const truncate = (s: string) => (s.length > MAX_DESC_CHARS ? s.slice(0, MAX_DESC_CHARS) : s);

// ─── Pass 1: classify (CS-relevance + opportunity_type) ───────────────────────────────

export interface ClassifyResult {
  csRelevant: boolean;
  opportunityType: OpportunityType | null;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    cs_relevant: { type: "boolean" },
    opportunity_type: { type: ["string", "null"], enum: [...OPPORTUNITY_TYPES, null] },
  },
  required: ["cs_relevant", "opportunity_type"],
} as const;

const CLASSIFY_SYSTEM = `You classify job listings for a Computer-Science opportunities hub aimed at students and new grads.

Decide two things:

1. cs_relevant (boolean): true if the role is CS-adjacent — software / SWE, data / ML, security, hardware / embedded / firmware, devops / SRE / infrastructure, quantitative, or a technical product/program role. Non-technical roles (sales, marketing, HR, finance, recruiting, operations, non-technical design) are NOT cs_relevant.

2. opportunity_type: which early-career category the role is, or null if none apply:
   - "internship": an internship
   - "co_op": a multi-term co-op
   - "fellowship": a fellowship program
   - "new_grad": an entry-level / new-graduate full-time role
   - "research": a research program or research-assistant role
   - "part_time": an ongoing part-time role suitable for a student
   Use null for senior / experienced / manager / staff roles or anything that is not one of these early-career categories — EVEN IF it is cs_relevant.

IMPORTANT — stated experience requirements override the title. If the description states a minimum of 1 or more years of professional experience ("2+ years", "3-5 years of experience"), the role is NOT early-career: return null for opportunity_type no matter how junior the title sounds. A range that starts at zero ("0-3 years", "0 to 1 year") does NOT disqualify the role. Titles like "Junior", "Associate", "Analyst" or "Researcher" are NOT evidence of an early-career role on their own — check the stated requirements.

A listing is kept only if cs_relevant is true AND opportunity_type is not null. When unsure whether a role is genuinely early-career, prefer null.`;

export async function classify(listing: NormalizedListing): Promise<ClassifyResult> {
  const user = [
    `Title: ${listing.title}`,
    `Company: ${listing.company}`,
    `Department: ${listing.department ?? "(none)"}`,
    "",
    "Description:",
    truncate(listing.descriptionPlain),
  ].join("\n");

  const out = await chatJson<{
    cs_relevant: boolean;
    opportunity_type: OpportunityType | null;
  }>({ system: CLASSIFY_SYSTEM, user, schema: CLASSIFY_SCHEMA });

  return { csRelevant: out.cs_relevant, opportunityType: out.opportunity_type };
}

// ─── Pass 2: extract (grad year / citizenship / deadline) ─────────────────────────────

export interface ExtractResult {
  gradYearMin: number | null;
  gradYearMax: number | null;
  citizenshipStatus: CitizenshipStatus | null;
  applicationDeadline: Date | null;
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    grad_year_min: { type: ["integer", "null"] },
    grad_year_max: { type: ["integer", "null"] },
    citizenship_status: { type: ["string", "null"], enum: [...CITIZENSHIP, null] },
    application_deadline: { type: ["string", "null"] },
  },
  required: [
    "grad_year_min",
    "grad_year_max",
    "citizenship_status",
    "application_deadline",
  ],
} as const;

// Abstain-when-unsure is the load-bearing instruction here (Decision 7 / FEATURES): a wrong
// extracted value silently corrupts a filter, so null is always safer than a guess.
const EXTRACT_SYSTEM = `You extract structured fields from a job description. Return null for any field you are not confident about — do NOT guess.

- grad_year_min / grad_year_max: the graduation-year window the role targets. "graduating in 2026 or 2027" -> min 2026, max 2027; a single year -> both equal that year. Null if not stated. NEVER infer a year from a salary figure, a zip code, or any unrelated number.
- citizenship_status: one of "us_citizen_required", "no_sponsorship", "sponsorship_available", "unknown". Use "unknown" only when the posting explicitly discusses work authorization but is ambiguous. Use null when the posting says nothing about it — absence of a statement is NOT permission.
- application_deadline: the APPLICATION deadline as an ISO date "YYYY-MM-DD". Null if not stated or if applications are rolling. Do NOT mistake a program start/end date ("program runs June 1 - Aug 15") for an application deadline.`;

// A JSON schema guarantees SHAPE (it's a string / an integer), never SEMANTICS (it's a real
// date / a plausible year). These two guards validate at that seam — model output crossing
// into our data model gets the same skepticism as an untrusted API.

// Strict YYYY-MM-DD only. `new Date("June 1")` and `new Date("06/01/2026")` both PARSE to a
// valid-but-wrong Date, which would defeat the "null beats a guess" intent — so reject
// anything that isn't the exact ISO calendar-date shape. Built at explicit UTC midnight so a
// negative-offset timezone doesn't render it as the day before.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const parseDate = (s: string): Date | null => {
  if (!ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

// A local model can emit a schema-valid integer that's nonsense — 90210 (misread a zip) or
// 2 (misread "2+ years experience"). Clamp to a plausible graduation window and null out the
// rest so a hallucinated year can't silently corrupt the grad-year filter.
const plausibleGradYear = (y: number | null): number | null => {
  if (y === null) return null;
  const now = new Date().getFullYear();
  return y >= now - 1 && y <= now + 6 ? y : null;
};

export async function extract(listing: NormalizedListing): Promise<ExtractResult> {
  const user = [
    `Title: ${listing.title}`,
    "",
    "Description:",
    truncate(listing.descriptionPlain),
  ].join("\n");

  const out = await chatJson<{
    grad_year_min: number | null;
    grad_year_max: number | null;
    citizenship_status: CitizenshipStatus | null;
    application_deadline: string | null;
  }>({ system: EXTRACT_SYSTEM, user, schema: EXTRACT_SCHEMA });

  return {
    gradYearMin: plausibleGradYear(out.grad_year_min),
    gradYearMax: plausibleGradYear(out.grad_year_max),
    citizenshipStatus: out.citizenship_status,
    applicationDeadline: out.application_deadline ? parseDate(out.application_deadline) : null,
  };
}
