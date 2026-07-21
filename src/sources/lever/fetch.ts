import type { RawJob } from "../../pipeline/types.js";

// Fetch raw job postings for one Lever company.
// TODO: HTTP GET + offset pagination (see research/ats-field-reference.md).
// NOTE: rate limiting (GATED) and retry/backoff (FIRST-DRAFT-MINE) are separate
// decisions — do not bake them in here.
export async function fetchLever(company: string): Promise<RawJob[]> {
  throw new Error("fetchLever not implemented");
}
