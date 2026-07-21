import type {
  Source,
  EmploymentType,
  WorkplaceType,
  CompInterval,
  CitizenshipStatus,
} from "@prisma/client";

// Raw payload from a source API. Shape is source-specific, so it stays `unknown`
// until each source's normalize() narrows it.
export type RawJob = unknown;

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

// After the extract stage: normalized + AI-derived fields.
export interface EnrichedListing extends NormalizedListing {
  gradYearMin: number | null;
  gradYearMax: number | null;
  citizenshipStatus: CitizenshipStatus | null;
}
