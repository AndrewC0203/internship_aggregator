import { esc } from "./render.js";
import { subPage } from "./render-shell.js";
import type { RecResult, RecItem } from "../recommend/rank.js";

// "For You" view (spec "API + UI"). Design laws carried over from the board: monochrome
// bands (weight + inversion, never hue — blue means NEW and nothing else), qualitative
// bands only (cosine is never a percentage), badges annotate and never filter.

const BAND_LABEL: Record<RecItem["band"], string> = {
  strong: "STRONG MATCH",
  good: "GOOD MATCH",
  fair: "FURTHER",
};

const FORYOU_CSS = `
.fy-head{display:flex;align-items:baseline;gap:16px;font-family:var(--mono);margin-bottom:14px}
.fy-head b{font-size:18px}
.fy-gap{font-size:11px;color:var(--ink-3);letter-spacing:.06em}
.rec{background:var(--bg1);border:1px solid var(--line);padding:14px 16px;margin-bottom:10px;display:grid;gap:6px}
.rec-top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.band{font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.14em;padding:3px 7px;border:1px solid var(--line-2);color:var(--ink-2)}
.band.strong{background:var(--ink);color:var(--bg0);border-color:var(--ink)}
.band.good{color:var(--ink);border-color:var(--ink-2)}
.rec-title{font-size:14px;font-weight:600}
.rec-title a{color:var(--ink);text-decoration:none}
.rec-title a:hover{text-decoration:underline}
.rec-co{font-family:var(--mono);font-size:11px;color:var(--ink-2);letter-spacing:.08em}
.rec-meta{font-family:var(--mono);font-size:10px;color:var(--ink-3);letter-spacing:.06em;display:flex;gap:14px;flex-wrap:wrap}
.rec-skills{font-size:12px;color:var(--ink-2)}
.rec-skills b{color:var(--ink);font-weight:600}
.tag{font-family:var(--mono);font-size:9px;letter-spacing:.1em;padding:2px 6px;border:1px solid var(--line-2);color:var(--ink-3)}
.tag.gap{color:var(--ink);border-color:var(--ink-2)}
.tag.due{color:var(--ink);border-color:var(--ink)}
.cta{display:inline-block;margin-top:10px;font-family:var(--mono);font-size:11px;letter-spacing:.14em;color:var(--bg0);background:var(--ink);padding:10px 16px;text-decoration:none}
`;

function recRow(r: RecItem): string {
  const tags: string[] = [];
  if (r.chip.state === "gaps") {
    tags.push(`<span class="tag gap" title="from extracted facts">STATED GAPS: ${esc(r.chip.facts.join(" · ").toUpperCase())}</span>`);
  } else if (r.chip.state === "clear") {
    tags.push(`<span class="tag" title="we only check what we extract">NO GAPS FOUND IN CHECKED REQUIREMENTS</span>`);
  } else {
    tags.push(`<span class="tag">ELIGIBILITY UNVERIFIED</span>`);
  }
  if (r.selectivity) {
    tags.push(`<span class="tag" title="hand-curated list — see data/company-tiers.json">HIGHLY SELECTIVE EMPLOYER · CURATED</span>`);
  }
  if (r.deadlineDaysLeft !== null && r.deadlineDaysLeft >= 0 && r.deadlineDaysLeft <= 14) {
    tags.push(`<span class="tag due">CLOSES IN ${r.deadlineDaysLeft}D</span>`);
  }
  if (r.citizenshipUnverified) tags.push(`<span class="tag">SPONSORSHIP UNSTATED</span>`);
  if (r.locationUnresolved) tags.push(`<span class="tag">LOCATION UNRESOLVED</span>`);

  return `<article class="rec">
  <div class="rec-top">
    <span class="band ${r.band}">${BAND_LABEL[r.band]}</span>
    <span class="rec-co">${esc(r.company.toUpperCase())}</span>
    <span class="rec-meta">
      ${r.opportunityType ? `<span>${esc(r.opportunityType.toUpperCase())}</span>` : ""}
      ${r.csField ? `<span>${esc(r.csField.toUpperCase())}</span>` : ""}
      ${r.location ? `<span>${esc(r.location)}</span>` : ""}
    </span>
  </div>
  <div class="rec-title"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title.trim())}</a></div>
  ${r.matchedSkills.length ? `<div class="rec-skills">MATCHED SKILLS: <b>${esc(r.matchedSkills.join(", "))}</b></div>` : ""}
  <div class="rec-meta">${tags.join(" ")}</div>
</article>`;
}

export function renderForYouPage(res: RecResult, page: number): string {
  let body: string;

  if (res.state === "no_profile") {
    body = `<div class="panel">
  <h2>NO PROFILE YET</h2>
  <p class="note">For You ranks listings against your approved profile. Paste a resume and approve it once — everything after that is math, no model calls at browse time.</p>
  <a class="cta" href="/profile">SET UP PROFILE</a>
</div>`;
  } else if (res.state === "stale_embedding") {
    body = `<div class="panel">
  <h2>PROFILE EMBEDDING OUT OF DATE</h2>
  <p class="note">The stored profile vector was produced under a different embedding model or template than the current configuration. Re-approve the profile to re-embed it — recommendations stay off until then (a silent mismatch would rank in the wrong vector space).</p>
  <a class="cta" href="/profile">RE-APPROVE PROFILE</a>
</div>`;
  } else {
    const totalPages = Math.max(1, Math.ceil(res.total / res.per));
    body = `<div class="fy-head">
  <span><b>${res.total}</b> MATCHES</span>
  ${res.excludedUnenriched > 0 ? `<span class="fy-gap">${res.excludedUnenriched} LISTINGS NOT YET ENRICHED — EXCLUDED UNTIL EMBEDDED</span>` : ""}
</div>
${res.items.map(recRow).join("\n")}
<nav class="sheets" aria-label="pagination">
  ${page > 1 ? `<a class="sheet-btn" href="/foryou?page=${page - 1}">PREV</a>` : `<span class="sheet-btn off">PREV</span>`}
  <span class="sheet-pos">PAGE ${page} / ${totalPages}</span>
  ${page < totalPages ? `<a class="sheet-btn" href="/foryou?page=${page + 1}">NEXT</a>` : `<span class="sheet-btn off">NEXT</span>`}
</nav>`;
  }

  return subPage({ title: "CS Opportunities — For You", active: "foryou", body, extraCss: FORYOU_CSS });
}
