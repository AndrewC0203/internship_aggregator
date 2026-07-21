import type { RawJob } from "../../pipeline/types.js";

// Fetch raw job postings for one Ashby job board.
// TODO: POST /jobPosting.list + cursor pagination (see research/ats-field-reference.md).
// NOTE: rate limiting (GATED) and retry/backoff (FIRST-DRAFT-MINE) are separate
// decisions — do not bake them in here.
export async function fetchAshby(jobBoardName: string): Promise<RawJob[]> {
  throw new Error("fetchAshby not implemented");
}
