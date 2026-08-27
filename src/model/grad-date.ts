// Grad-date parsing + class-year policy (Decision 17). Same fact-vs-policy split as
// experience.ts: parseGradDate() answers "what did the posting state?", classYear() applies
// OUR rule for which graduating class that month belongs to. Keeping them separate means the
// class-year rule can change and the stored grad_date_min/max strings re-derive the year
// columns without another model pass.
//
// Why this exists: postings state eligibility as month windows ("graduating between September
// 2027 and June 2028"). The old extraction schema forced bare integer years, so the model
// lossily truncated that to 2027–2028 — making a Spring-2027 grad look eligible when the
// posting excludes them. Extracting the stated month verbatim is EASIER for the model than
// converting (it's copying, not inference), and the conversion bug moves into testable code.

export interface GradDate {
  year: number;
  month: number | null; // null = the posting stated a bare year ("class of 2027")
}

// Strict "YYYY" or "YYYY-MM" only, mirroring the ISO_DATE guard in classifier.ts: the model's
// schema constrains SHAPE, this validates SEMANTICS (a real month, a 4-digit year). Anything
// else is treated as an abstain — null beats a guess.
const GRAD_DATE = /^(\d{4})(?:-(\d{2}))?$/;

export function parseGradDate(s: string): GradDate | null {
  const m = GRAD_DATE.exec(s.trim());
  if (!m) return null;
  const year = Number(m[1]);
  if (m[2] === undefined) return { year, month: null };
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

// The month a graduation rolls into the FOLLOWING class year. August through December grads
// (semester systems' "Fall") belong with the next spring's class — a Dec 2027 grad applies
// alongside the class of 2028, and postings that say "Sep 2027 – June 2028" mean exactly that
// one class. January–July (spring/summer grads) keep their calendar year.
const FALL_START_MONTH = 8;

// A stated bare year ("graduating in 2027") maps to itself — the user-facing assumption is
// "unspecified month means Spring", and Spring keeps the calendar year, so no adjustment.
export function classYear(d: GradDate): number {
  if (d.month !== null && d.month >= FALL_START_MONTH) return d.year + 1;
  return d.year;
}
