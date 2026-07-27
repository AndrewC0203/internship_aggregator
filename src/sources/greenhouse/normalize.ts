import type {
  RawJob,
  NormalizedListing,
  NormalizeContext,
} from "../../pipeline/types.js";
import { decodeHtmlEntities, htmlToPlain } from "../../pipeline/html.js";

// Minimal shape of a Greenhouse Job Board job (content=true) — only the fields we map.
// TODO: verify against a real captured payload (a board's /jobs?content=true response)
// before trusting this; the Job Board API's exact field presence varies.
interface GreenhouseJob {
  id: number;
  title: string;
  content: string; // HTML, entity-ENCODED by Greenhouse (e.g. "&lt;p&gt;")
  absolute_url: string;
  company_name?: string | null;
  location?: { name?: string | null } | null;
  departments?: Array<{ name?: string | null }> | null;
  first_published?: string | null;
  updated_at?: string | null;
}

// Pure function: Greenhouse raw job -> NormalizedListing, or null to drop the job. No I/O —
// unit-testable against a fixture. Maps only the DIRECTLY-AVAILABLE fields; employment_type /
// workplace_type / comp / grad-year / citizenship / opportunity_type are inferred/classified
// downstream (GATED stages), so they are NOT set here.
export function normalizeGreenhouse(
  raw: RawJob,
  ctx: NormalizeContext,
): NormalizedListing | null {
  const job = raw as GreenhouseJob;

  // crawl_targets (Decision 11) is slug-only, so ctx.company is never populated for a
  // discovery-sourced board — company_name from the payload is the only source of truth.
  // ats-field-reference.md documents it as always-present, but nothing in the type system
  // guarantees that at runtime, so a missing/blank value drops just this job (decided:
  // skip, not fallback-to-token) rather than stamping a wrong company onto a listing.
  const company = job.company_name?.trim();
  if (!company) {
    return null;
  }

  return {
    source: "greenhouse",
    sourceExternalId: String(job.id),
    company,
    title: job.title,

    // Greenhouse `content` is entity-encoded HTML. Decode once to get real HTML for
    // display; derive plain text (block tags -> whitespace) for classify/search (Decision 6).
    descriptionHtml: decodeHtmlEntities(job.content ?? ""),
    descriptionPlain: htmlToPlain(job.content ?? ""),

    location: job.location?.name ?? null,
    // Greenhouse departments can be multiple/hierarchical; flattened to the first per
    // Decision 5. TODO: decide if "deepest" is better than "first" once we see real data.
    department: job.departments?.[0]?.name ?? null,

    employmentType: null, // inferred downstream (Greenhouse doesn't provide it)
    workplaceType: null, // inferred downstream
    compMin: null, // TODO: map pay_input_ranges if present on the board payload
    compMax: null,
    compCurrency: null,
    compInterval: null,

    publishedAt: job.first_published ? new Date(job.first_published) : null,
    applicationDeadline: null, // TODO: map application_deadline if present; else extracted

    url: job.absolute_url,
  };
}
