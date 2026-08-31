import type { OpportunityType, CitizenshipStatus, CsField, DegreeStatus } from "@prisma/client";
import type { NormalizedListing } from "../pipeline/types.js";
import { chatJson } from "./ollama.js";
import { parseGradDate, classYear } from "./grad-date.js";

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

const CS_FIELDS = [
  "swe",
  "ml_ai",
  "data",
  "quant",
  "security",
  "hardware_embedded",
  "devops_infra",
  "it",
  "product",
  "other",
] as const;

const CITIZENSHIP = [
  "us_citizen_required",
  "no_sponsorship",
  "sponsorship_available",
  "unknown",
] as const;

const DEGREE_STATUS = ["pursuing", "completed_required", "unknown"] as const;

// Per-pass model split (Decision 25, measured in research/model-rebenchmark-m5max.md):
// classify runs the 14B — it was right on 7-8 of 8 adjudicated disagreements (all 7B errors
// were false keeps of non-CS roles) and costs only ~+0.3s/call, since classify is
// prefill-bound and emits ~20 tokens. Extract stays on the 7B — the 14B is 2.3× slower there
// (the degree_evidence quote makes extract decode-heavy) and showed the benchmark's only
// hallucination (inventing a grad window from a "Fall 2026" start term).
//
// Precedence: per-pass env > global OLLAMA_MODEL > these defaults. The global keeps forcing
// ONE model everywhere (bench scripts, A/B reclassify runs). Exported for tests; env is a
// parameter so tests don't mutate process.env.
export function passModel(
  pass: "classify" | "extract",
  env: Record<string, string | undefined> = process.env,
): string {
  const perPass = pass === "classify" ? env.OLLAMA_CLASSIFY_MODEL : env.OLLAMA_EXTRACT_MODEL;
  const fallback = pass === "classify" ? "qwen2.5:14b-instruct" : "qwen2.5:7b-instruct";
  return perPass ?? env.OLLAMA_MODEL ?? fallback;
}

// Boundary guard for degree_status (Decision 24), same seam as gradField/parseDate below:
// Ollama's structured-output enum enforcement is an external guarantee we don't own, so
// anything that isn't exactly one of our values normalizes to null rather than leaking into
// a row. Exported for tests.
export function normalizeDegreeStatus(raw: string | null): DegreeStatus | null {
  return (DEGREE_STATUS as readonly string[]).includes(raw ?? "")
    ? (raw as DegreeStatus)
    : null;
}

// Bound the description we send so a pathologically long posting can't blow up the context /
// latency. 6000 chars is comfortably enough for grad-year / visa / deadline signals.
const MAX_DESC_CHARS = 6000;
const truncate = (s: string) => (s.length > MAX_DESC_CHARS ? s.slice(0, MAX_DESC_CHARS) : s);

// ─── Pass 1: classify (CS-relevance + opportunity_type) ───────────────────────────────

export interface ClassifyResult {
  csRelevant: boolean;
  opportunityType: OpportunityType | null;
  csField: CsField | null;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    cs_relevant: { type: "boolean" },
    opportunity_type: { type: ["string", "null"], enum: [...OPPORTUNITY_TYPES, null] },
    cs_field: { type: ["string", "null"], enum: [...CS_FIELDS, null] },
  },
  required: ["cs_relevant", "opportunity_type", "cs_field"],
} as const;

const CLASSIFY_SYSTEM = `You classify job listings for a Computer-Science opportunities hub aimed at students and new grads.

Decide three things:

1. cs_relevant (boolean): true if the role is CS-adjacent — software / SWE, data / ML, security, hardware / embedded / firmware, devops / SRE / infrastructure, quantitative, or a technical product/program role. Non-technical roles (sales, marketing, HR, finance, recruiting, operations, non-technical design) are NOT cs_relevant.

IT roles are split: engineering-side IT (systems administration, networking, cloud infrastructure, IT security, scripting/automation) IS cs_relevant; service-side IT (help desk, service desk, desktop/desk-side support, phone or ticket-based customer support, hardware break-fix, AV support) is NOT cs_relevant, even when the title says "IT" or "Technical Support".

2. cs_field: the role's PRIMARY technical subfield, or null:
   - "swe": software engineering (backend, frontend, full-stack, mobile, platform)
   - "ml_ai": machine learning / AI
   - "data": data science, data engineering, data analytics
   - "quant": quantitative research / trading / development
   - "security": security engineering, cybersecurity
   - "hardware_embedded": hardware, embedded, firmware, chip/FPGA
   - "devops_infra": devops, SRE, cloud/infrastructure engineering
   - "it": engineering-side IT (sysadmin, networking) — never service-side (that is not cs_relevant at all)
   - "product": technical product / program management
   - "other": cs_relevant but none of the above
   If the role straddles fields, pick the dominant one from the title. Use null when cs_relevant is false, or when you cannot tell.

3. opportunity_type: which early-career category the role is, or null if none apply:
   - "internship": an internship
   - "co_op": a multi-term co-op
   - "fellowship": a fellowship program
   - "new_grad": an entry-level / new-graduate full-time role
   - "research": a research program or research-assistant role
   - "part_time": an ongoing part-time role suitable for a student
   Use null for senior / experienced / manager / staff roles or anything that is not one of these early-career categories — EVEN IF it is cs_relevant.

IMPORTANT — stated experience requirements override the title. If the description states a minimum of 1 or more years of professional experience ("2+ years", "3-5 years of experience"), the role is NOT early-career: return null for opportunity_type no matter how junior the title sounds. A range that starts at zero ("0-3 years", "0 to 1 year") does NOT disqualify the role. Titles like "Junior", "Associate", "Analyst" or "Researcher" are NOT evidence of an early-career role on their own — check the stated requirements.

A listing is kept only if cs_relevant is true AND opportunity_type is not null. When unsure whether a role is genuinely early-career, prefer null.`;

// Pick<> rather than the full NormalizedListing: classify only reads these four fields, and
// the narrower type lets the reclassify command (src/reclassify.ts) pass a DB row straight in
// without fabricating the rest of a NormalizedListing it doesn't have (e.g. duplicateKeys).
export type ClassifyInput = Pick<
  NormalizedListing,
  "title" | "company" | "department" | "descriptionPlain"
>;

export async function classify(listing: ClassifyInput): Promise<ClassifyResult> {
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
    cs_field: CsField | null;
  }>({ system: CLASSIFY_SYSTEM, user, schema: CLASSIFY_SCHEMA, model: passModel("classify") });

  return {
    csRelevant: out.cs_relevant,
    opportunityType: out.opportunity_type,
    // A subfield only makes sense on a CS-relevant keep; a stray label on a reject would be
    // noise if it ever leaked into a row, so normalize it away at the boundary.
    csField: out.cs_relevant ? out.cs_field : null,
  };
}

// ─── Pass 2: extract (grad year / citizenship / deadline) ─────────────────────────────

export interface ExtractResult {
  // Verbatim stated window ("YYYY-MM" / "YYYY", validated) — the facts (Decision 17)…
  gradDateMin: string | null;
  gradDateMax: string | null;
  // …and the class years derived from them in code (Aug–Dec rolls forward; see grad-date.ts).
  gradYearMin: number | null;
  gradYearMax: number | null;
  citizenshipStatus: CitizenshipStatus | null;
  degreeStatus: DegreeStatus | null;
  applicationDeadline: Date | null;
}

// grad_date_* replaced the old grad_year_* integers (Decision 17): forcing integers made the
// model lossily truncate "September 2027 – June 2028" to 2027–2028, which wrongly includes
// Spring-2027 grads. Copying the stated month is easier for a 7B than converting it.
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    grad_date_min: { type: ["string", "null"] },
    grad_date_max: { type: ["string", "null"] },
    citizenship_status: { type: ["string", "null"], enum: [...CITIZENSHIP, null] },
    // degree_evidence comes BEFORE degree_status on purpose: Ollama's grammar makes the model
    // emit fields in schema order, so it must quote the degree sentence before classifying it.
    // Measured on the audit cases (research/degree-status-audit.md): without the quote step the
    // 7B anchored on "Intern" in the title and answered "pursuing" for every posting; with it,
    // the WhiteWater false-internship correctly came back completed_required. The evidence
    // string is discarded after the call — it exists to steer generation, not to be stored.
    degree_evidence: { type: ["string", "null"] },
    degree_status: { type: ["string", "null"], enum: [...DEGREE_STATUS, null] },
    application_deadline: { type: ["string", "null"] },
  },
  required: [
    "grad_date_min",
    "grad_date_max",
    "citizenship_status",
    "degree_evidence",
    "degree_status",
    "application_deadline",
  ],
} as const;

// Abstain-when-unsure is the load-bearing instruction here (Decision 7 / FEATURES): a wrong
// extracted value silently corrupts a filter, so null is always safer than a guess.
const EXTRACT_SYSTEM = `You extract structured fields from a job description. Return null for any field you are not confident about — do NOT guess.

- grad_date_min / grad_date_max: the graduation window the role targets, copied EXACTLY as stated. Use "YYYY-MM" when the posting gives a month ("graduating between September 2027 and June 2028" -> min "2027-09", max "2028-06") and bare "YYYY" when it only gives years ("graduating in 2026 or 2027" -> min "2026", max "2027"). A single stated date -> both fields equal it. Do NOT convert months to years or seasons — copy what is written. Null if not stated. NEVER infer a year from a salary figure, a zip code, or any unrelated number.
- citizenship_status: one of "us_citizen_required", "no_sponsorship", "sponsorship_available", "unknown". Use "unknown" only when the posting explicitly discusses work authorization but is ambiguous. Use null when the posting says nothing about it — absence of a statement is NOT permission.
- degree_evidence: the single sentence from the description that best states its degree requirement, copied verbatim. Null if the description never mentions degrees. The job title is NOT evidence — only description text counts.
- degree_status: classify the degree_evidence sentence you just copied. "pursuing": it says the candidate is currently pursuing / enrolled in / working toward a degree, or states an expected graduation date or class-year requirement. "completed_required": it requires an already-finished degree ("Bachelor's degree required", "must hold a PhD") and the description nowhere says pursuing/enrolled — if both kinds of statement appear, "pursuing" wins. "unknown": degrees are mentioned but neither reading is stated. Null: degree_evidence is null.
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

// Validate a raw model grad-date string down to (verbatim string, derived class year) — or
// (null, null) when it's malformed or implausible. The plausibility clamp runs on the DERIVED
// year, and a failed clamp nulls the stored string too: a fact we don't believe shouldn't be
// kept around looking authoritative.
const gradField = (raw: string | null): { date: string | null; year: number | null } => {
  if (!raw) return { date: null, year: null };
  const parsed = parseGradDate(raw);
  if (!parsed) return { date: null, year: null };
  const year = plausibleGradYear(classYear(parsed));
  return year === null ? { date: null, year: null } : { date: raw.trim(), year };
};

// Same Pick<> rationale as ClassifyInput: lets reclassify pass a DB row directly.
export type ExtractInput = Pick<NormalizedListing, "title" | "descriptionPlain">;

export async function extract(listing: ExtractInput): Promise<ExtractResult> {
  const user = [
    `Title: ${listing.title}`,
    "",
    "Description:",
    truncate(listing.descriptionPlain),
  ].join("\n");

  const out = await chatJson<{
    grad_date_min: string | null;
    grad_date_max: string | null;
    citizenship_status: CitizenshipStatus | null;
    degree_evidence: string | null;
    degree_status: string | null;
    application_deadline: string | null;
  }>({ system: EXTRACT_SYSTEM, user, schema: EXTRACT_SCHEMA, model: passModel("extract") });

  const min = gradField(out.grad_date_min);
  const max = gradField(out.grad_date_max);

  return {
    gradDateMin: min.date,
    gradDateMax: max.date,
    gradYearMin: min.year,
    gradYearMax: max.year,
    citizenshipStatus: out.citizenship_status,
    degreeStatus: normalizeDegreeStatus(out.degree_status),
    applicationDeadline: out.application_deadline ? parseDate(out.application_deadline) : null,
  };
}
