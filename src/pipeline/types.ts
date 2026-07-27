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

// The natural key of a listing — how a reject flows through the pipeline (rejects never
// carry a full row, only their key, so non-CS content never reaches the product table;
// Decision 12 / Decision 10 amendment).
export interface ListingKey {
  source: Source;
  sourceExternalId: string;
}

// After the classify pass (Decision 12): normalized + the classified opportunity type.
// A keep always has a non-null type — the regex accept-router or the model assigns one;
// rejects don't reach this stage.
export interface ClassifiedListing extends NormalizedListing {
  opportunityType: OpportunityType;
}

// After the extract pass: classified + the AI-extracted body fields (grad year, citizenship;
// applicationDeadline already lives on NormalizedListing and is filled/kept there).
export interface EnrichedListing extends ClassifiedListing {
  gradYearMin: number | null;
  gradYearMax: number | null;
  citizenshipStatus: CitizenshipStatus | null;
}
