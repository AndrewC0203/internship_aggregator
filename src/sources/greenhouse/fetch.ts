import type { RawJob } from "../../pipeline/types.js";

// Fetch raw job postings for one Greenhouse board.
// TODO: HTTP GET + follow Link-header pagination (see research/ats-field-reference.md).
// NOTE: rate limiting (GATED) and retry/backoff (FIRST-DRAFT-MINE) are separate
// decisions — do not bake them in here.
export async function fetchGreenhouse(boardToken: string): Promise<RawJob[]> {
  throw new Error("fetchGreenhouse not implemented");
}
