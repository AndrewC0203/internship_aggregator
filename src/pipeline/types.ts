import type {
  Source,
  EmploymentType,
  WorkplaceType,
  CompInterval,
  CitizenshipStatus,
  OpportunityType,
} from "@prisma/client";

// Raw payload from a source API. Shape is source-specific, so it stays `unknown`
// until each source's normalize() narrows it.
export type RawJob = unknown;

// Context a normalize() needs beyond the raw payload. `company` is optional: crawl_targets
// (Decision 11) is slug-only, so most sources must derive company from the payload itself
// instead of relying on this context (see each source's normalize() for how).
export interface NormalizeContext {
  company?: string;
}

// Output of a source's normalize() step — the source-derived fields only.
// AI-extracted fields (gradYear*, citizenshipStatus) are added later by extract().
export interface NormalizedListing {
  source: Source;
  sourceExternalId: string;
  company: string;
  title: string;
  descriptionHtml: string;
  descriptionPlain: string;
  location: string | null;
  department: string | null;
  employmentType: EmploymentType | null;
  workplaceType: WorkplaceType | null;
  compMin: number | null;
  compMax: number | null;
  compCurrency: string | null;
  compInterval: CompInterval | null;
  publishedAt: Date | null;
  applicationDeadline: Date | null;
  url: string;
}

// After the classify + extract stages: normalized + AI-derived fields.
// opportunityType is set by the classification stage; the grad-year/citizenship
// fields by the extraction stage. Both are GATED (undecided) — absent from normalize().
export interface EnrichedListing extends NormalizedListing {
  opportunityType: OpportunityType | null;
  gradYearMin: number | null;
  gradYearMax: number | null;
  citizenshipStatus: CitizenshipStatus | null;
}
