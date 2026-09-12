import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { minYearsExperience } from "../pipeline/stages/experience.js";
import type { Questionnaire } from "./questionnaire.js";

// Labels (Decision 32): attainability = alignment chip + curated selectivity badge. Both
// ANNOTATE, never filter; every label is traceable to shown facts or a curated list with
// stated methodology. No probability claims anywhere — that design died under audit.

// ── Alignment chip ───────────────────────────────────────────────────────────────────────
// Wording rule: never "meets requirements" — we only check what we extract. Three states:
//   clear      -> "No gaps found in checked requirements" (something was checkable, no
//                 contradiction found)
//   gaps       -> "Stated gaps: <facts>" (facts always shown, never a bare verdict)
//   unverified -> "Eligibility unverified" (nothing on this listing was checkable)

export type ChipState = "clear" | "gaps" | "unverified";

export interface AlignmentChip {
  state: ChipState;
  facts: string[];
}

export interface ChipInput {
  descriptionPlain: string;
  gradYearMin: number | null;
  gradYearMax: number | null;
  citizenshipStatus: string | null;
  degreeStatus: string | null;
}

// The chip re-derives work-auth contradictions even though ranking's hard filters usually
// remove them: the chip must stand alone so the ordinary search page can reuse it later.
export function alignmentChip(l: ChipInput, q: Questionnaire): AlignmentChip {
  const facts: string[] = [];
  let checkable = 0;

  // Stated years-of-experience: deterministic regex fact parser (Decision 14) at read time —
  // YOE was deliberately never stored (write-time drops only), so the chip recomputes it.
  const yoe = minYearsExperience(l.descriptionPlain);
  if (yoe !== null) {
    checkable++;
    if (yoe > 0) facts.push(`states ${yoe}+ years of experience`);
  }

  if (l.gradYearMin !== null && l.gradYearMax !== null && q.gradYearMin !== null && q.gradYearMax !== null) {
    checkable++;
    const overlaps = l.gradYearMin <= q.gradYearMax && l.gradYearMax >= q.gradYearMin;
    if (!overlaps) facts.push(`targets class of ${l.gradYearMin}–${l.gradYearMax}`);
  }

  if (l.degreeStatus !== null) {
    checkable++;
    if (l.degreeStatus === "completed_required") facts.push("requires a completed degree");
  }

  if (l.citizenshipStatus !== null && l.citizenshipStatus !== "unknown") {
    checkable++;
    if (l.citizenshipStatus === "us_citizen_required" && q.usCitizen === false)
      facts.push("requires US citizenship");
    if (l.citizenshipStatus === "no_sponsorship" && q.needsSponsorship === true)
      facts.push("does not sponsor visas");
  }

  if (facts.length > 0) return { state: "gaps", facts };
  return checkable > 0 ? { state: "clear", facts: [] } : { state: "unverified", facts: [] };
}

// ── Selectivity badge ────────────────────────────────────────────────────────────────────

export const SELECTIVITY_BADGE_TEXT = "Highly selective employer — manually curated";

// data/ lives at the repo root, two levels up from src/recommend/.
const TIERS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "company-tiers.json");

let tierSet: Set<string> | null = null;

function loadTiers(): Set<string> {
  if (tierSet) return tierSet;
  const raw = JSON.parse(readFileSync(TIERS_PATH, "utf8")) as { companies?: unknown };
  const companies = Array.isArray(raw.companies)
    ? raw.companies.filter((c): c is string => typeof c === "string")
    : [];
  tierSet = new Set(companies.map((c) => c.trim().toLowerCase()));
  return tierSet;
}

// Fixed wording, or null = NOT ASSESSED. Null is rendered as nothing at all — an unlisted
// company must never be implied "less selective" by any visual treatment.
export function selectivityBadge(company: string): string | null {
  return loadTiers().has(company.trim().toLowerCase()) ? SELECTIVITY_BADGE_TEXT : null;
}
