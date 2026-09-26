import type { RawJob, FetchResult } from "../../pipeline/types.js";

// The repo's machine-readable listings file lives on the `dev` branch (the branch Simplify
// actually maintains; `main` lags). raw.githubusercontent.com serves real ETags, so the
// Decision 23 conditional-fetch path works unchanged — one 13MB download when the file
// changed, a ~0-byte 304 when it didn't.
const BASE = "https://raw.githubusercontent.com";
const LISTINGS_PATH = "dev/.github/scripts/listings.json";
// 30s vs the ATS fetchers' 10s: this is one ~13MB file (measured 2026-09-25), not a small
// per-board payload.
const TIMEOUT_MS = 30_000;

// Same shape as GreenhouseFetchError: callers inspect `status` (429 pause) instead of
// parsing messages.
export class SimplifyFetchError extends Error {
  constructor(
    message: string,
    public readonly repo: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SimplifyFetchError";
  }
}

interface SimplifyRawEntry {
  active?: boolean;
  is_visible?: boolean;
}

// Fetch the full listings file for one Simplify repo (`token` = "owner/repo", e.g.
// "SimplifyJobs/Summer2026-Internships" — so their New-Grad repo is just another
// crawl_targets row later).
//
// Returns ACTIVE + VISIBLE entries only. The ATS APIs only ever serve live postings, and the
// whole pipeline downstream (absence-based delisting above all) reads FetchResult.jobs as
// "the board's live set". Simplify's file instead RETAINS dead entries flagged active:false
// (12.5k of 17k at time of writing) — filtering here restores the shared "present = live"
// semantic instead of pushing a source-specific flag into every downstream stage.
export async function fetchSimplify(
  repo: string,
  priorEtag: string | null = null,
): Promise<FetchResult> {
  const url = `${BASE}/${repo}/${LISTINGS_PATH}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(priorEtag ? { "If-None-Match": priorEtag } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new SimplifyFetchError(
        `Simplify fetch timed out after ${TIMEOUT_MS}ms for repo "${repo}"`,
        repo,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new SimplifyFetchError(`Simplify fetch network error for repo "${repo}": ${reason}`, repo);
  } finally {
    clearTimeout(timeout);
  }

  // 304 before !ok — the SUCCESS case of a conditional request (same as greenhouse/fetch.ts).
  if (res.status === 304) {
    return { kind: "not_modified" };
  }

  if (!res.ok) {
    throw new SimplifyFetchError(
      `Simplify fetch failed for repo "${repo}": ${res.status} ${res.statusText}`,
      repo,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SimplifyFetchError(
      `Simplify returned non-JSON response for repo "${repo}"`,
      repo,
      res.status,
    );
  }

  if (!Array.isArray(body)) {
    // The file is always a top-level array (even were it empty). Anything else means the
    // response isn't shaped how we expect — a fetch failure, not an empty repo.
    throw new SimplifyFetchError(
      `Simplify response was not a listings array for repo "${repo}"`,
      repo,
      res.status,
    );
  }

  const live = body.filter((entry: unknown): entry is RawJob => {
    const e = entry as SimplifyRawEntry | null;
    return typeof e === "object" && e !== null && e.active === true && e.is_visible === true;
  });

  // Etag captured only from a fully-validated 200, so a malformed response can never poison
  // the stored validator (same invariant as greenhouse/fetch.ts).
  return { kind: "ok", jobs: live, etag: res.headers.get("etag") };
}
