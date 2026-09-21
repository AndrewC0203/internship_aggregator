import { subPage } from "./render-shell.js";

// Tryout page: paste ANY resume -> top matches, fully stateless (see /api/tryout — nothing
// is persisted; this exists for manually testing other people's resumes and for demos).
// Kept deliberately separate from /search's own "paste and go" (Decision 34 addendum) —
// that flow caches a draft server-side and can be saved as your profile; this one never
// does either, by design, so someone else's resume can never end up in user_profile.
// Results render client-side from the JSON response — there is no stored state to
// server-render from, and reloading would discard the pasted resume.

const TRYOUT_CSS = `
textarea,input[type=text]{width:100%;background:var(--bg2);border:1px solid var(--line-2);color:var(--ink);font-family:var(--mono);font-size:12px;padding:8px;border-radius:0}
textarea:focus,input:focus{outline:1px solid var(--ink-2)}
.btn{font-family:var(--mono);font-size:11px;letter-spacing:.14em;color:var(--bg0);background:var(--ink);border:0;padding:10px 16px;cursor:pointer}
.pg-status{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--ink-3);min-height:14px}
.rec{background:var(--bg1);border:1px solid var(--line);padding:12px 16px;margin-bottom:8px}
.rec-top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-family:var(--mono);font-size:10px;color:var(--ink-2);letter-spacing:.08em}
.band{font-size:9px;font-weight:700;letter-spacing:.14em;padding:3px 7px;border:1px solid var(--line-2);color:var(--ink-2)}
.band.strong{background:var(--ink);color:var(--bg0);border-color:var(--ink)}
.band.good{color:var(--ink);border-color:var(--ink-2)}
.rec-title{font-size:14px;font-weight:600;margin:4px 0}
.rec-title a{color:var(--ink);text-decoration:none}
.rec-title a:hover{text-decoration:underline}
.rec-skills{font-size:12px;color:var(--ink-2)}
.rec-skills b{color:var(--ink)}
.mono-tag{font-family:var(--mono);font-size:9px;letter-spacing:.12em;border:1px solid var(--line-2);padding:2px 6px;color:var(--ink-2)}
`;

export function renderTryoutPage(): string {
  const body = `
<h2>TRYOUT · RANK ANY RESUME AGAINST THE CORPUS</h2>
<div class="panel" style="display:grid;gap:12px">
  <textarea id="resume" rows="12" placeholder="Paste a resume as plain text — nothing is saved; extraction, embedding, and ranking happen in memory and are discarded."></textarea>
  <div><label for="interests" style="font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:var(--ink-2)">OPTIONAL INTERESTS (soft steering, e.g. "prefer ML roles")</label>
  <input type="text" id="interests"></div>
  <div style="display:flex;gap:16px;align-items:center">
    <button class="btn" id="go">EXTRACT &amp; RANK TOP 10</button>
    <span class="pg-status" id="status"></span>
  </div>
  <p class="note">Runs the exact production path — quote-grounded 14B extraction, then pure-math ranking over the enriched corpus. Your own saved profile is untouched. Takes ~15–30s (local model).</p>
</div>
<div id="out" style="margin-top:16px"></div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
$("go").onclick = async () => {
  $("status").textContent = "EXTRACTING + RANKING… (~15-30s)";
  $("out").innerHTML = "";
  const res = await fetch("/api/tryout", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeText: $("resume").value, interests: $("interests").value }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("status").textContent = res.status === 503 ? (d.hint || "OLLAMA DOWN — RUN: ollama serve")
      : (d.error || "FAILED") + (d.reason ? ": " + d.reason : "");
    return;
  }
  $("status").textContent = "";
  const head = '<p class="note">EXTRACTED SKILLS: ' + d.extracted.skills.map(s => '<span class="mono-tag">' + esc(s) + '</span>').join(" ")
    + (d.extracted.dropped.length ? ' · DROPPED (no resume evidence): ' + esc(d.extracted.dropped.join(", ")) : "")
    + '</p><p class="note">' + d.total + ' ELIGIBLE · ' + d.excludedUnenriched + ' NOT YET ENRICHED (EXCLUDED)</p>';
  const rows = d.items.map(r => '<article class="rec">'
    + '<div class="rec-top"><span class="band ' + r.band + '">' + (r.band === "strong" ? "STRONG MATCH" : r.band === "good" ? "GOOD MATCH" : "FURTHER") + '</span>'
    + '<span>' + esc(r.company.toUpperCase()) + '</span>'
    + (r.opportunityType ? '<span>' + esc(r.opportunityType.toUpperCase()) + '</span>' : "")
    + (r.location ? '<span>' + esc(r.location) + '</span>' : "")
    + (r.variantCount > 1 ? '<span title="' + esc(r.locations.join(" · ")) + '">+' + (r.variantCount - 1) + ' MORE LOC</span>' : "") + '</div>'
    + '<div class="rec-title"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.title.trim()) + '</a></div>'
    + (r.matchedSkills.length ? '<div class="rec-skills">SKILLS IN COMMON: <b>' + esc(r.matchedSkills.join(", ")) + '</b></div>' : "")
    + (r.chip.state === "gaps" ? '<div class="rec-top"><span class="mono-tag">STATED GAPS: ' + esc(r.chip.facts.join(" · ").toUpperCase()) + '</span></div>' : "")
    + '</article>').join("");
  $("out").innerHTML = head + rows;
};
</script>`;

  return subPage({ title: "CS Opportunities — Tryout", active: "tryout", body, extraCss: TRYOUT_CSS });
}
