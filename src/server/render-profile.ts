import { esc } from "./render.js";
import { subPage } from "./render-shell.js";
import type { Questionnaire } from "../recommend/questionnaire.js";
import type { ProfileJson } from "../recommend/canonical.js";
import type { ExtractedProfile } from "../model/profile-extract.js";

// Profile setup page (spec "User profile flow" + "Questionnaire"). The ownership split is
// VISIBLE structure: an extracted (model-written) panel the user reads, and an approved
// panel the user edits and publishes — nothing downstream reads the former.

export interface ProfilePageData {
  resumeText: string | null;
  extractedProfile: ExtractedProfile | null;
  profile: ProfileJson | null;
  questionnaire: Questionnaire;
  revision: number;
  embeddingCurrent: boolean | null; // null = no embedding stored
}

const TYPES = ["internship", "co_op", "fellowship", "new_grad", "research", "part_time"];
const FIELDS = [
  "swe", "ml_ai", "data", "quant", "security",
  "hardware_embedded", "devops_infra", "it", "product", "other",
];

const PROFILE_CSS = `
.pg-grid{display:grid;gap:16px}
textarea,input[type=text],input[type=number]{width:100%;background:var(--bg2);border:1px solid var(--line-2);color:var(--ink);font-family:var(--mono);font-size:12px;padding:8px;border-radius:0}
textarea:focus,input:focus{outline:1px solid var(--ink-2)}
textarea{resize:vertical}
.pg-row{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.pg-row label{font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:var(--ink-2)}
.pg-opts{display:flex;gap:10px;flex-wrap:wrap}
.pg-opt{display:flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--ink-2);border:1px solid var(--line-2);padding:4px 8px;cursor:pointer}
.pg-opt input{accent-color:var(--ink)}
.btn{font-family:var(--mono);font-size:11px;letter-spacing:.14em;color:var(--bg0);background:var(--ink);border:0;padding:10px 16px;cursor:pointer}
.btn.ghost{background:transparent;color:var(--ink-2);border:1px solid var(--line-2)}
.pg-status{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--ink-3);min-height:14px}
.pg-dropped{font-size:11px;color:var(--ink-3)}
.mono-tag{font-family:var(--mono);font-size:9px;letter-spacing:.12em;border:1px solid var(--line-2);padding:2px 6px;color:var(--ink-2)}
`;

const yesNoNull = (name: string, value: boolean | null, labels: [string, string]): string => `
<span class="pg-opts" role="radiogroup" aria-label="${esc(name)}">
  <label class="pg-opt"><input type="radio" name="${name}" value="yes" ${value === true ? "checked" : ""}>${labels[0]}</label>
  <label class="pg-opt"><input type="radio" name="${name}" value="no" ${value === false ? "checked" : ""}>${labels[1]}</label>
  <label class="pg-opt"><input type="radio" name="${name}" value="na" ${value === null ? "checked" : ""}>NOT ANSWERED</label>
</span>`;

export function renderProfilePage(d: ProfilePageData): string {
  const q = d.questionnaire;
  const editable = d.profile ?? d.extractedProfile;
  const fieldRow = (f: string): string => {
    const sel = q.targetFields.find((t) => t.field === f);
    return `<span class="pg-opt">
  <input type="checkbox" name="tf" value="${f}" ${sel ? "checked" : ""}>
  ${f.toUpperCase()}
  <input type="checkbox" name="tf-must" value="${f}" ${sel?.mustHave ? "checked" : ""} title="must-have: promotes this field to a hard filter"> MUST
</span>`;
  };

  const body = `
<h2>1 · RESUME (PASTE PLAIN TEXT)</h2>
<div class="panel pg-grid">
  <textarea id="resume" rows="10" placeholder="Paste your resume as plain text — PDF parsing is v2.">${esc(d.resumeText ?? "")}</textarea>
  <div class="pg-row">
    <button class="btn" id="extract">EXTRACT WITH LOCAL MODEL</button>
    <span class="pg-status" id="extract-status"></span>
  </div>
  <p class="note">Extraction is quote-grounded: the model may only claim skills it can point to in your resume. Runs locally (14B) — needs <span class="mono-tag">ollama serve</span>.</p>
</div>

<h2>2 · EXTRACTED (MODEL-WRITTEN — READ ONLY)</h2>
<div class="panel pg-grid">
  ${
    d.extractedProfile
      ? `<div>SKILLS: ${d.extractedProfile.skills.map((s) => `<span class="mono-tag">${esc(s)}</span>`).join(" ")}</div>
         <div class="note">FOCUS: ${esc(d.extractedProfile.focus)}</div>
         ${d.extractedProfile.dropped.length ? `<div class="pg-dropped">DROPPED (no resume evidence found): ${esc(d.extractedProfile.dropped.join(", "))}</div>` : ""}`
      : `<p class="note">Nothing extracted yet.</p>`
  }
</div>

<h2>3 · APPROVED PROFILE (YOURS — THIS IS WHAT RANKS)</h2>
<div class="panel pg-grid">
  <div><label for="skills">SKILLS (comma-separated, demonstrated only)</label>
  <input type="text" id="skills" value="${esc((editable?.skills ?? []).join(", "))}"></div>
  <div><label for="focus">TECHNICAL FOCUS (one sentence)</label>
  <textarea id="focus" rows="2">${esc(editable?.focus ?? "")}</textarea></div>
</div>

<h2>4 · QUESTIONNAIRE</h2>
<div class="panel pg-grid">
  <div class="pg-row"><label>GRADUATION WINDOW</label>
    <input type="number" id="gradYearMin" min="2020" max="2040" value="${q.gradYearMin ?? ""}" placeholder="from" style="width:90px">
    <input type="number" id="gradYearMax" min="2020" max="2040" value="${q.gradYearMax ?? ""}" placeholder="to" style="width:90px">
    <span class="note">Listings stating no window stay visible (badged, never dropped).</span>
  </div>
  <div class="pg-row"><label>US CITIZEN?</label>${yesNoNull("usCitizen", q.usCitizen, ["YES", "NO"])}</div>
  <div class="pg-row"><label>CURRENTLY WORK-AUTHORIZED?</label>${yesNoNull("workAuthorized", q.workAuthorized, ["YES", "NO"])}</div>
  <div class="pg-row"><label>NEED SPONSORSHIP (NOW OR LATER)?</label>${yesNoNull("needsSponsorship", q.needsSponsorship, ["YES", "NO"])}</div>
  <div class="pg-row"><label for="locStates">US STATES</label>
    <input type="text" id="locStates" value="${esc(q.locStates.join(", "))}" placeholder="NY, CA" style="width:180px">
    <label for="locCountries">COUNTRIES</label>
    <input type="text" id="locCountries" value="${esc(q.locCountries.join(", "))}" placeholder="US" style="width:120px">
    <label class="pg-opt"><input type="checkbox" id="remoteOk" ${q.remoteOk ? "checked" : ""}>REMOTE OK</label>
  </div>
  <div class="pg-row"><label>TYPES WANTED</label>
    <span class="pg-opts">${TYPES.map((t) => `<label class="pg-opt"><input type="checkbox" name="types" value="${t}" ${q.types.includes(t) ? "checked" : ""}>${t.toUpperCase()}</label>`).join("")}</span>
  </div>
  <div class="pg-row"><label>TARGET FIELDS (soft; MUST = hard filter)</label>
    <span class="pg-opts">${FIELDS.map(fieldRow).join("")}</span>
  </div>
  <div><label for="interests">FREE-TEXT INTERESTS (soft — merged into your Seeking section)</label>
  <textarea id="interests" rows="2">${esc(q.interests)}</textarea></div>
</div>

<div class="pg-row" style="margin-top:16px">
  <button class="btn" id="publish">APPROVE &amp; PUBLISH</button>
  <button class="btn ghost" id="save-q">SAVE QUESTIONNAIRE ONLY</button>
  <span class="pg-status" id="publish-status"></span>
</div>
<p class="note">Publishing embeds your profile locally and versions it (revision ${d.revision}${
    d.embeddingCurrent === null ? ", no embedding yet" : d.embeddingCurrent ? ", embedding current" : ", embedding STALE — re-approve"
  }). Approved content is the only thing ranking ever reads.</p>

<script>
const $ = (id) => document.getElementById(id);
const REV = ${d.revision};
const radio = (name) => {
  const v = document.querySelector('input[name="'+name+'"]:checked')?.value;
  return v === "yes" ? true : v === "no" ? false : null;
};
const list = (id) => $(id).value.split(",").map(s => s.trim()).filter(Boolean);
const num = (id) => { const n = Number($(id).value); return Number.isInteger(n) && n > 0 ? n : null; };
function questionnaire() {
  const musts = new Set([...document.querySelectorAll('input[name="tf-must"]:checked')].map(i => i.value));
  return {
    gradYearMin: num("gradYearMin"), gradYearMax: num("gradYearMax"),
    usCitizen: radio("usCitizen"), workAuthorized: radio("workAuthorized"),
    needsSponsorship: radio("needsSponsorship"),
    locStates: list("locStates"), locCountries: list("locCountries"),
    remoteOk: $("remoteOk").checked,
    types: [...document.querySelectorAll('input[name="types"]:checked')].map(i => i.value),
    targetFields: [...document.querySelectorAll('input[name="tf"]:checked')].map(i => ({ field: i.value, mustHave: musts.has(i.value) })),
    interests: $("interests").value,
  };
}
async function call(el, method, url, body) {
  el.textContent = "WORKING…";
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.ok) { el.textContent = "OK — RELOADING"; location.reload(); return; }
  if (res.status === 409) { el.textContent = "CONFLICT: A NEWER EDIT EXISTS — RELOAD THE PAGE"; return; }
  if (res.status === 503) { el.textContent = "OLLAMA DOWN — RUN: ollama serve"; return; }
  el.textContent = (data.error || "FAILED") + (data.reason ? ": " + data.reason : "");
}
$("extract").onclick = () => call($("extract-status"), "POST", "/api/profile/resume", { resumeText: $("resume").value });
$("publish").onclick = () => call($("publish-status"), "PUT", "/api/profile", {
  profile: { skills: list("skills"), focus: $("focus").value }, questionnaire: questionnaire(), revision: REV });
$("save-q").onclick = () => call($("publish-status"), "PUT", "/api/profile/questionnaire", { questionnaire: questionnaire(), revision: REV });
</script>`;

  return subPage({ title: "CS Opportunities — Profile", active: "profile", body, extraCss: PROFILE_CSS });
}
