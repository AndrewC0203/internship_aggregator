import type { CitizenshipStatus, CsField } from "@prisma/client";
import type {
  RawJob,
  NormalizedListing,
  NormalizeContext,
  ListingKey,
} from "../../pipeline/types.js";

// Normalizer for the SimplifyJobs GitHub repo feed (Decision 38). Structurally unlike the
// ATS normalizers in two ways:
//   1. Entries carry NO description — descriptionPlain/Html are SYNTHESIZED from the
//      structured fields (category/term/locations/degrees), informative parts first so the
//      Decision 35 embed text (title + description head) gets signal, provenance last.
//   2. The repo's curation IS the classification: every entry ships `preclassified`
//      (internship + category→cs_field + sponsorship→citizenship), which routes it around
//      the AI filter/extract stages entirely (pipeline/stages/preclassified.ts).

interface SimplifyEntry {
  id: string;
  company_name: string;
  title: string;
  url: string;
  locations?: string[];
  category?: string;
  terms?: string[];
  degrees?: string[];
  sponsorship?: string;
  date_posted?: number;
}

// The repo's category vocabulary, observed 2026-09-25 (research/simplify-source-measurements.md)
// — a handful of values, some with long/short spellings. "AI/ML/Data" spans ml_ai and data;
// single-label rule (Decision 16) forces the dominant field, so ml_ai. Unknown → null: abstain,
// never guess — same posture as the accept-router's csFieldFromTitle.
const CATEGORY_TO_CS_FIELD: Record<string, CsField> = {
  Software: "swe",
  "Software Engineering": "swe",
  "AI/ML/Data": "ml_ai",
  "Data Science, AI & Machine Learning": "ml_ai",
  Quant: "quant",
  Hardware: "hardware_embedded",
  "Hardware Engineering": "hardware_embedded",
  Product: "product",
  "Product Management": "product",
};

// "Other" (99.5% of entries, measured) is the repo's "didn't say" — maps to null, matching
// the extraction rule that absence is not a statement (Decision 24 posture).
const SPONSORSHIP_TO_CITIZENSHIP: Record<string, CitizenshipStatus> = {
  "U.S. Citizenship is Required": "us_citizen_required",
  "Does Not Offer Sponsorship": "no_sponsorship",
  "Offers Sponsorship": "sponsorship_available",
};

// Parse the ATS-native natural key out of a Simplify application URL (Decision 39). This is
// what makes cross-source dedup exact instead of fuzzy: for the three ATSs we crawl, the URL
// embeds the ATS's OWN job id — the very value our normalizers store as sourceExternalId
// (Greenhouse: numeric id in /jobs/<id>, gh_jid=, or embed token=; Lever/Ashby: posting UUID).
// Non-ATS hosts (Workday etc., 81% of entries) return null — nothing to alias.
export function parseAtsAlias(url: string): ListingKey | null {
  const gh =
    url.match(/(?:job-)?boards\.greenhouse\.io\/[^/?#]+\/jobs\/(\d+)/i) ??
    url.match(/[?&]gh_jid=(\d+)/i) ??
    url.match(/greenhouse\.io\/embed\/job_app\?[^#]*\btoken=(\d+)/i);
  if (gh) return { source: "greenhouse", sourceExternalId: gh[1] };

  const lever = url.match(/jobs\.lever\.co\/[^/?#]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (lever) return { source: "lever", sourceExternalId: lever[1].toLowerCase() };

  const ashby = url.match(/jobs\.ashbyhq\.com\/[^/?#]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (ashby) return { source: "ashby", sourceExternalId: ashby[1].toLowerCase() };

  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeSimplify(raw: RawJob, _ctx: NormalizeContext): NormalizedListing | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Partial<SimplifyEntry>;

  // Identity fields are non-negotiable — drop the entry rather than guess (same rule as
  // Ashby's missing-company drop).
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const company = typeof entry.company_name === "string" ? entry.company_name.trim() : "";
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (!id || !company || !title || !url) return null;

  const locations = (entry.locations ?? []).map((l) => l.trim()).filter(Boolean);
  const terms = (entry.terms ?? []).map((t) => t.trim()).filter(Boolean);
  const degrees = (entry.degrees ?? []).map((d) => d.trim()).filter(Boolean);
  const category = typeof entry.category === "string" ? entry.category.trim() : "";

  // Semicolon-joined multi-location string — the exact shape the Decision 19 location parser
  // already handles ("London, UK; ...; San Francisco, CA").
  const location = locations.length > 0 ? locations.join("; ") : null;

  // Synthetic description: honest structured facts only, nothing invented. Ordered so the
  // informative fields lead (they join the embed text) and provenance trails.
  const parts: string[] = [];
  if (category) parts.push(`Category: ${category}`);
  if (terms.length > 0) parts.push(`Term: ${terms.join(", ")}`);
  if (location) parts.push(`Locations: ${location}`);
  if (degrees.length > 0) parts.push(`Degrees: ${degrees.join(", ")}`);
  const descriptionPlain =
    `${parts.join(". ")}${parts.length > 0 ? ". " : ""}` +
    `Curated listing from the SimplifyJobs internships repo — it publishes no posting text; ` +
    `see the application link for the full description.`;

  const postedAt =
    typeof entry.date_posted === "number" && entry.date_posted > 0
      ? new Date(entry.date_posted * 1000)
      : null;

  const alias = parseAtsAlias(url);

  return {
    source: "simplify",
    sourceExternalId: id,
    company,
    title,
    descriptionHtml: `<p>${escapeHtml(descriptionPlain)}</p>`,
    descriptionPlain,
    location,
    department: null,
    // Deliberately null, not "intern": employment_type is "what the ATS said" (Decision 5/10
    // split) and this feed states none — the internship claim lives in preclassified below.
    employmentType: null,
    workplaceType: null,
    compMin: null,
    compMax: null,
    compCurrency: null,
    compInterval: null,
    publishedAt: postedAt,
    applicationDeadline: null,
    url,
    duplicateKeys: alias ? [alias] : [],
    preclassified: {
      opportunityType: "internship",
      csField: CATEGORY_TO_CS_FIELD[category] ?? null,
      citizenshipStatus: entry.sponsorship
        ? (SPONSORSHIP_TO_CITIZENSHIP[entry.sponsorship] ?? null)
        : null,
    },
  };
}
