// SSR renderer for the search page — the Dispatch Board world (see the direction contract
// in the emitted <body>). Pure function: (params, result) -> HTML string. All CSS/JS inline;
// the only external requests are the two self-hosted woff2 files.
import type { SearchParams, SearchResult } from "./search.js";
import { NEW_WINDOW_DAYS } from "./search.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// --- label vocabularies -------------------------------------------------------------------

const TYPE_LABEL: Record<string, string> = {
  internship: "INTERNSHIP", co_op: "CO-OP", fellowship: "FELLOWSHIP",
  new_grad: "NEW GRAD", research: "RESEARCH", part_time: "PART-TIME",
};
const FIELD_LABEL: Record<string, string> = {
  swe: "SWE", ml_ai: "ML/AI", data: "DATA", quant: "QUANT", security: "SEC",
  hardware_embedded: "HW/EMB", devops_infra: "DEVOPS", it: "IT", product: "PRODUCT", other: "OTHER",
};
const STATUS_LABEL: Record<string, string> = {
  none: "UNTOUCHED", saved: "SAVED", applied: "APPLIED",
  interviewing: "INTERVIEW", offer: "OFFER", rejected: "REJECTED",
};
const CITIZEN_LABEL: Record<string, string> = {
  us_citizen_required: "USC REQ", no_sponsorship: "NO SPON", sponsorship_available: "SPON OK",
};

// --- querystring helpers ------------------------------------------------------------------

// Serialize params back to a querystring, with overrides. `null` removes a key.
function qs(p: SearchParams, over: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {};
  if (p.q) base.q = p.q;
  if (p.type) base.type = p.type.join(",");
  if (p.field) base.field = p.field.join(",");
  if (p.country) base.country = p.country.join(",");
  if (p.state) base.state = p.state.join(",");
  if (p.gradYear) base.gradYear = String(p.gradYear);
  if (p.status) base.status = p.status.join(",");
  if (p.newOnly) base.new = "1";
  if (p.sort && p.sort !== "first_seen") base.sort = p.sort;
  if (p.page && p.page > 1) base.page = String(p.page);
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  // Any filter change resets to sheet 1 unless the override IS the page.
  if (!("page" in over)) delete base.page;
  const s = new URLSearchParams(base).toString();
  return s ? `/?${s}` : "/";
}

// Toggle one value inside a comma-list param.
function toggled(current: string[] | undefined, value: string): string | null {
  const set = new Set(current ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return set.size ? [...set].join(",") : null;
}

// --- row fragments ------------------------------------------------------------------------

const fmtDate = (d: Date | null): string =>
  d ? `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";

function gradWindow(min: number | null, max: number | null): string {
  if (min == null && max == null) return "";
  const yy = (y: number) => `’${String(y).slice(2)}`;
  if (min != null && max != null) return min === max ? yy(min) : `${yy(min)}–${yy(max)}`;
  if (min != null) return `${yy(min)}+`;
  return `≤${yy(max as number)}`;
}

// The block lamp. One hue, one rule: amber = awaiting your decision (new & untouched),
// white = held (saved), green = in-flight (applied/interviewing/offer). Rejected rows go
// dark — a closed block loses its light — and red belongs to deadline pressure only.
function lamp(status: string | null, isNew: boolean): string {
  if (status === "saved") return `<span class="lamp lit-white" aria-label="saved"></span>`;
  if (status === "applied" || status === "interviewing" || status === "offer")
    return `<span class="lamp lit-green" aria-label="${status}"></span>`;
  if (status === "rejected") return `<span class="lamp closed" aria-label="rejected"></span>`;
  if (isNew) return `<span class="lamp lit-amber" aria-label="new, awaiting decision"></span>`;
  return `<span class="lamp" aria-label="untouched"></span>`;
}

function statusControl(id: number, current: string | null): string {
  const opts: Array<[string, string, string]> = [
    ["saved", "S", "Save (hold this block)"],
    ["applied", "A", "Mark applied"],
    ["interviewing", "I", "Mark interviewing"],
    ["offer", "O", "Mark offer"],
    ["rejected", "X", "Mark rejected"],
  ];
  const btns = opts
    .map(
      ([val, key, tip]) =>
        `<button class="throw${current === val ? " on" : ""}" data-id="${id}" data-status="${val}" title="${tip}" aria-pressed="${current === val}">${key}</button>`,
    )
    .join("");
  return `<span class="throws" role="group" aria-label="application status">${btns}</span>`;
}

function row(r: SearchResult["rows"][number]): string {
  const deadlineDelta = r.applicationDeadline
    ? r.applicationDeadline.getTime() - Date.now()
    : null;
  // Red = live pressure only (raise 4). A passed deadline is a closed window, not urgency.
  const deadlineSoon = deadlineDelta !== null && deadlineDelta > 0 && deadlineDelta < 14 * 86400_000;
  const deadlinePassed = deadlineDelta !== null && deadlineDelta <= 0;
  const meta: string[] = [];
  if (r.csField) meta.push(`<span class="code">${FIELD_LABEL[r.csField] ?? r.csField}</span>`);
  const grad = gradWindow(r.gradYearMin, r.gradYearMax);
  return `<tr class="block${r.status === "rejected" ? " closed" : ""}${r.isNew && !r.status ? " fresh" : ""}" data-id="${r.id}"${r.isNew ? " data-new" : ""} tabindex="0">
<td class="c-lamp">${lamp(r.status, r.isNew)}</td>
<td class="c-co"><span class="co" title="${esc(r.company)}">${esc(r.company)}</span></td>
<td class="c-title"><a href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.title.trim())} — opens at ${esc(r.company)}">${esc(r.title.trim())}</a>
  <span class="m-meta">${meta.join("")}${r.location ? `<span class="loc">${esc(r.location)}</span>` : ""}${grad ? `<span class="loc">${grad}</span>` : ""}${r.citizenshipStatus && r.citizenshipStatus !== "unknown" ? `<span class="loc">${CITIZEN_LABEL[r.citizenshipStatus] ?? ""}</span>` : ""}</span></td>
<td class="c-field">${r.csField ? `<span class="code">${FIELD_LABEL[r.csField] ?? r.csField}</span>` : ""}</td>
<td class="c-loc" title="${esc(r.location ?? "")}">${esc((r.location ?? "").length > 26 ? (r.location ?? "").slice(0, 25) + "…" : (r.location ?? ""))}</td>
<td class="c-grad">${grad}</td>
<td class="c-cit">${r.citizenshipStatus && r.citizenshipStatus !== "unknown" ? `<span class="cit">${CITIZEN_LABEL[r.citizenshipStatus] ?? ""}</span>` : ""}</td>
<td class="c-seen">${r.applicationDeadline ? `<span class="deadline${deadlineSoon ? " soon" : ""}${deadlinePassed ? " past" : ""}" title="application deadline">${deadlinePassed ? "CLOSED" : "DUE"} ${fmtDate(r.applicationDeadline)}</span>` : fmtDate(r.firstSeenAt)}</td>
<td class="c-throw">${statusControl(r.id, r.status)}</td>
</tr>`;
}

// --- rail fragments -----------------------------------------------------------------------

function lever(href: string, label: string, count: number | undefined, on: boolean): string {
  return `<a class="lever${on ? " on" : ""}" href="${href}" aria-current="${on ? "true" : "false"}">
<span class="pip"></span><span class="lv-label">${label}</span><span class="lv-count">${count ?? 0}</span></a>`;
}

function railGroup(title: string, body: string, open = true): string {
  return `<details class="grp"${open ? " open" : ""}><summary>${title}</summary>${body}</details>`;
}

// --- page ---------------------------------------------------------------------------------

export function renderPage(p: SearchParams, res: SearchResult): string {
  const totalSheets = Math.max(1, Math.ceil(res.total / res.per));
  const anyFilter =
    !!(p.q || p.type || p.field || p.country || p.state || p.gradYear || p.status || p.newOnly);

  // Plate counts: overall corpus split by type under everything EXCEPT type (facet counts).
  const plateCounts = Object.entries(TYPE_LABEL)
    .map(([val, label]) => {
      const on = p.type?.includes(val) ?? false;
      return `<a class="plate-count${on ? " on" : ""}" href="${qs(p, { type: toggled(p.type, val) })}">
<span class="pc-n">${res.facets.type[val] ?? 0}</span><span class="pc-l">${label}</span></a>`;
    })
    .join("");

  // Rail groups.
  const typeLevers = Object.entries(TYPE_LABEL)
    .map(([val, label]) =>
      lever(qs(p, { type: toggled(p.type, val) }), label, res.facets.type[val], p.type?.includes(val) ?? false),
    )
    .join("");
  const fieldLevers = Object.entries(FIELD_LABEL)
    .map(([val, label]) =>
      lever(qs(p, { field: toggled(p.field, val) }), label, res.facets.field[val], p.field?.includes(val) ?? false),
    )
    .join("");
  const stateEntries = Object.entries(res.facets.state);
  const stateLevers = stateEntries
    .slice(0, 12)
    .map(([val, count]) =>
      lever(qs(p, { state: toggled(p.state, val) }), val, count, p.state?.includes(val) ?? false),
    )
    .join("");
  const stateMore = stateEntries
    .slice(12)
    .map(([val, count]) =>
      lever(qs(p, { state: toggled(p.state, val) }), val, count, p.state?.includes(val) ?? false),
    )
    .join("");
  const countryLevers = Object.entries(res.facets.country)
    .slice(0, 8)
    .map(([val, count]) =>
      lever(qs(p, { country: toggled(p.country, val) }), val, count, p.country?.includes(val) ?? false),
    )
    .join("");
  const statusLevers = Object.entries(STATUS_LABEL)
    .map(([val, label]) =>
      lever(qs(p, { status: toggled(p.status, val) }), label, res.facets.status[val], p.status?.includes(val) ?? false),
    )
    .join("");
  const years = [2026, 2027, 2028, 2029];
  const yearLevers = years
    .map((y) =>
      `<a class="lever${p.gradYear === y ? " on" : ""}" href="${qs(p, { gradYear: p.gradYear === y ? null : String(y) })}" aria-current="${p.gradYear === y ? "true" : "false"}"><span class="pip"></span><span class="lv-label">CLASS OF ’${String(y).slice(2)}</span></a>`,
    )
    .join("");
  const sorts: Array<[SearchParams["sort"], string]> = [
    ["first_seen", "FIRST SEEN"], ["published", "PUBLISHED"], ["company", "COMPANY"],
  ];
  const sortLevers = sorts
    .map(([val, label]) =>
      `<a class="lever${(p.sort ?? "first_seen") === val ? " on" : ""}" href="${qs(p, { sort: val === "first_seen" ? null : (val as string) })}" aria-current="${(p.sort ?? "first_seen") === val ? "true" : "false"}"><span class="pip"></span><span class="lv-label">${label}</span></a>`,
    )
    .join("");

  // Board rows with NEW / EARLIER dividers (only meaningful on the freshness sort).
  let rowsHtml = "";
  if (res.rows.length === 0) {
    rowsHtml = `<tr class="empty-row"><td colspan="9">
<div class="empty"><p class="empty-head">NO BLOCKS ON THE LINE</p>
<p class="empty-sub">No listings match the thrown levers.</p>
${anyFilter ? `<a class="clear-btn" href="/">RESET ALL LEVERS</a>` : ""}</div></td></tr>`;
  } else {
    const showDividers = (p.sort ?? "first_seen") === "first_seen" && !p.newOnly;
    let inNew = false;
    let openedEarlier = false;
    const parts: string[] = [];
    for (let i = 0; i < res.rows.length; i++) {
      const r = res.rows[i];
      if (showDividers && i === 0 && r.isNew) {
        parts.push(`<tr class="divider new-div"><td colspan="9"><span>NEW ON THE BOARD</span><span class="div-detail">${res.newCount} BLOCKS · LAST ${NEW_WINDOW_DAYS} DAYS</span></td></tr>`);
        inNew = true;
      }
      if (showDividers && inNew && !r.isNew && !openedEarlier) {
        parts.push(`<tr class="divider"><td colspan="9"><span>EARLIER</span></td></tr>`);
        openedEarlier = true;
      }
      parts.push(row(r));
    }
    rowsHtml = parts.join("\n");
  }

  const pageHref = (n: number) => qs(p, { page: n <= 1 ? null : String(n) });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatch Board — CS opportunities</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%23141D18'/><circle cx='8' cy='8' r='4' fill='%23FFB000'/></svg>`)}">
<style>${css()}</style>
</head>
<body>
<!--
THESIS: A job search run as a dispatcher's board — every listing a block on the line, every
apply-status a lamp you throw. Refuses the white-card job-board scaffold entirely.
OWN-WORLD: Backlit enamel CTC panel: deep green-black grounds (#0E1512/#141D18/#1B2721),
etched near-white legends (National Park — routed-signage face), Chivo Mono figures, indicator
lamps. One hue one rule: amber=awaiting decision, white=held, green=in-flight, red=deadline.
Status marks are hard figure-ground inversions. Rejected blocks go dark.
STORY: The dispatcher opens the board, reads the amber NEW blocks since the last pass, throws
levers to narrow the line, and dispatches each block — save, apply, strike — without leaving
the keyboard.
FIRST VIEWPORT: Full-width legend plate (name + live counts by type), interlocking filter rail
left (~260px), the line filling the rest: amber NEW divider on top, dense lamp-led rows below.
Primary action = the row itself (open + throw status).
FORM: Dispatch/CTC control board; candidate 5 of 7 on my grounded list; seed 2c04db5d.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the
verdict, DESIGN.md, and every shipping raster carrying its provenance.
-->
<a class="skip" href="#board">Skip to listings</a>
<header class="plate">
  <div class="plate-id">
    <h1>DISPATCH BOARD</h1>
    <span class="plate-sub">CS OPPORTUNITIES HUB</span>
  </div>
  <nav class="plate-counts" aria-label="listings by type">${plateCounts}</nav>
  <div class="plate-right">
    <a class="new-ind${p.newOnly ? " on" : ""}" href="${qs(p, { new: p.newOnly ? null : "1" })}" title="show only new blocks">
      <span class="lamp lit-amber"></span><span class="ni-n">${res.newCount}</span><span class="ni-l">NEW / ${NEW_WINDOW_DAYS}D</span></a>
  </div>
</header>
<div class="deck">
<aside class="interlocking" aria-label="filters">
  <form method="get" action="/" class="scan">
    <input type="search" name="q" value="${esc(p.q ?? "")}" placeholder="SCAN — title / company" aria-label="search title or company">
    ${p.type ? `<input type="hidden" name="type" value="${p.type.join(",")}">` : ""}
    ${p.field ? `<input type="hidden" name="field" value="${p.field.join(",")}">` : ""}
    ${p.state ? `<input type="hidden" name="state" value="${p.state.join(",")}">` : ""}
    ${p.country ? `<input type="hidden" name="country" value="${p.country.join(",")}">` : ""}
    ${p.status ? `<input type="hidden" name="status" value="${p.status.join(",")}">` : ""}
    ${p.gradYear ? `<input type="hidden" name="gradYear" value="${p.gradYear}">` : ""}
    ${p.newOnly ? `<input type="hidden" name="new" value="1">` : ""}
    ${p.sort && p.sort !== "first_seen" ? `<input type="hidden" name="sort" value="${p.sort}">` : ""}
  </form>
  ${railGroup("TYPE", `<div class="levers">${typeLevers}</div>`)}
  ${railGroup("FIELD", `<div class="levers">${fieldLevers}</div>`)}
  ${railGroup("US STATE", `<div class="levers">${stateLevers}</div>${stateMore ? `<details class="more"><summary>ALL STATES</summary><div class="levers">${stateMore}</div></details>` : ""}`)}
  ${railGroup("COUNTRY", `<div class="levers">${countryLevers}</div>`, false)}
  ${railGroup("CLASS YEAR", `<div class="levers" role="group" aria-label="class year">${yearLevers}</div><p class="grp-note">Listings stating no window stay visible.</p>`, false)}
  ${railGroup("MY PIPELINE", `<div class="levers">${statusLevers}</div>`, false)}
  ${railGroup("ORDER", `<div class="levers" role="group" aria-label="sort">${sortLevers}</div>`, false)}
  ${anyFilter ? `<a class="clear-btn rail-clear" href="/">RESET ALL LEVERS</a>` : ""}
  <p class="rail-legend">AMBER — awaiting decision<br>WHITE — held (saved)<br>GREEN — in flight<br>DARK — closed / rejected</p>
</aside>
<main class="board" id="board">
  <div class="board-head">
    <span class="bh-total"><b>${res.total}</b> BLOCKS ON THE LINE</span>
    <span class="bh-sheet">SHEET ${res.page} / ${totalSheets}</span>
  </div>
  <table class="line">
    <thead><tr>
      <th class="c-lamp" scope="col"><span class="vh">status lamp</span></th>
      <th class="c-co" scope="col">COMPANY</th>
      <th class="c-title" scope="col">POSITION</th>
      <th class="c-field" scope="col">FIELD</th>
      <th class="c-loc" scope="col">LOCATION</th>
      <th class="c-grad" scope="col" title="stated graduation window">CLASS</th>
      <th class="c-cit" scope="col" title="citizenship / sponsorship">CIT</th>
      <th class="c-seen" scope="col" title="first seen (or deadline)">SEEN</th>
      <th class="c-throw" scope="col">DISPATCH</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <nav class="sheets" aria-label="pagination">
    ${res.page > 1 ? `<a class="sheet-btn" href="${pageHref(res.page - 1)}">PREV</a>` : `<span class="sheet-btn off">PREV</span>`}
    <span class="sheet-pos">SHEET ${res.page} / ${totalSheets}</span>
    ${res.page < totalSheets ? `<a class="sheet-btn" href="${pageHref(res.page + 1)}">NEXT</a>` : `<span class="sheet-btn off">NEXT</span>`}
  </nav>
  <p class="board-foot">j/k move · s save · a applied · i interview · o offer · x reject · u clear · ⏎ open</p>
</main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>${js()}</script>
</body>
</html>`;
}

// --- styles -------------------------------------------------------------------------------

function css(): string {
  return `
@font-face{font-family:'National Park';src:url('/fonts/national-park.woff2') format('woff2');font-weight:200 800;font-display:swap}
@font-face{font-family:'Chivo Mono';src:url('/fonts/chivo-mono.woff2') format('woff2');font-weight:100 900;font-display:swap}
:root{
  --enamel-0:#0E1512; --enamel-1:#141D18; --enamel-2:#1B2721; --enamel-3:#24332B;
  --etch:#E9EFE9; --etch-dim:#A9BFB0; --etch-faint:#84998B;
  --amber:#FFB000; --amber-soft:#FFC24D; --green:#46C978; --white-lamp:#F2F7F0; --red:#FF6B5E;
  --groove:#0A100D; --ridge:#2C3D33;
  --sans:'National Park',system-ui,sans-serif; --mono:'Chivo Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--enamel-0)}
body{font-family:var(--sans);color:var(--etch);font-size:15px;line-height:1.45;min-height:100vh}
::selection{background:var(--amber);color:#141D18}
input{caret-color:var(--amber)}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px;border-radius:2px}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:var(--enamel-0)}
*::-webkit-scrollbar-thumb{background:var(--enamel-3);border-radius:5px;border:2px solid var(--enamel-0)}
a{color:inherit;text-decoration:none}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.skip{position:absolute;left:-9999px;top:0;background:var(--amber);color:#141D18;padding:8px 14px;font-weight:700;z-index:99}
.skip:focus{left:8px}

/* ---- legend plate ---- */
.plate{display:flex;align-items:center;gap:28px;padding:14px 22px 13px;
  background:linear-gradient(180deg,var(--enamel-2),var(--enamel-1));
  border-bottom:1px solid var(--groove);box-shadow:0 1px 0 var(--ridge) inset,0 6px 18px rgba(0,0,0,.35)}
.plate-id h1{font-size:19px;font-weight:700;letter-spacing:.14em}
.plate-sub{display:block;font-size:10px;font-weight:600;letter-spacing:.22em;color:var(--etch-faint);margin-top:1px}
.plate-counts{display:flex;gap:4px;flex:1;min-width:0;overflow-x:auto;padding-bottom:2px}
.plate-count{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 12px 4px;border-radius:4px;
  border:1px solid transparent;transition:background .15s,border-color .15s}
.plate-count:hover{background:var(--enamel-3)}
.plate-count.on{border-color:var(--ridge);background:var(--enamel-3);box-shadow:0 1px 4px rgba(0,0,0,.4) inset}
.pc-n{font-family:var(--mono);font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.pc-l{font-size:9px;font-weight:600;letter-spacing:.14em;color:var(--etch-dim)}
.plate-count.on .pc-l{color:var(--etch)}
.plate-right{display:flex;align-items:center}
.new-ind{display:flex;align-items:center;gap:8px;padding:7px 13px;border:1px solid var(--ridge);border-radius:5px;
  background:var(--enamel-1);transition:background .15s}
.new-ind:hover{background:var(--enamel-3)}
.new-ind.on{background:var(--amber);border-color:var(--amber)}
.new-ind.on .ni-n,.new-ind.on .ni-l{color:#141D18}
.new-ind.on .lamp{background:#141D18;box-shadow:none}
.ni-n{font-family:var(--mono);font-size:15px;font-weight:600}
.ni-l{font-size:9px;font-weight:700;letter-spacing:.14em;color:var(--etch-dim)}

/* ---- lamps ---- */
.lamp{display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--groove);
  box-shadow:0 1px 2px rgba(0,0,0,.6) inset;flex:none}
.lamp.lit-amber{background:var(--amber);box-shadow:0 0 2px rgba(255,176,0,.35),0 0 1px rgba(0,0,0,.4) inset}
.new-ind .lamp.lit-amber{box-shadow:0 0 6px 1px rgba(255,176,0,.55),0 0 1px rgba(0,0,0,.4) inset}
.lamp.lit-green{background:var(--green);box-shadow:0 0 2px rgba(70,201,120,.3),0 0 1px rgba(0,0,0,.4) inset}
.lamp.lit-white{background:var(--white-lamp);box-shadow:0 0 2px rgba(242,247,240,.3),0 0 1px rgba(0,0,0,.4) inset}
.lamp.closed{background:#050807;position:relative}
.lamp.closed::after{content:'';position:absolute;inset:3px;border-radius:50%;border:1px solid var(--etch-faint);opacity:.5}

/* ---- deck ---- */
.deck{display:grid;grid-template-columns:262px 1fr;gap:0;align-items:start;
  background:radial-gradient(140% 420px at 50% 0,rgba(233,239,233,.05),transparent 70%)}

/* ---- interlocking rail ---- */
.interlocking{position:sticky;top:0;max-height:100vh;overflow-y:auto;padding:16px 14px 28px;
  background:var(--enamel-1);border-right:1px solid var(--groove);box-shadow:1px 0 0 var(--ridge)}
.scan input{width:100%;background:var(--groove);border:1px solid var(--ridge);border-radius:4px;color:var(--etch);
  font-family:var(--mono);font-size:11.5px;padding:9px 11px;letter-spacing:.02em}
.scan input::placeholder{color:var(--etch-faint)}
.grp{margin-top:16px;border-top:1px solid var(--groove);padding-top:10px}
.grp summary{cursor:pointer;list-style:none;font-size:10.5px;font-weight:700;letter-spacing:.2em;color:var(--etch-dim);
  display:flex;align-items:center;gap:6px;padding:2px 4px;user-select:none}
.grp summary::before{content:'';width:0;height:0;border-left:5px solid var(--etch-faint);border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
.grp[open] summary::before{transform:rotate(90deg)}
.grp summary::-webkit-details-marker{display:none}
.levers{display:flex;flex-direction:column;margin-top:6px}
.lever{display:flex;align-items:center;gap:9px;padding:5px 6px;border-radius:4px;font-size:12px;font-weight:600;
  letter-spacing:.05em;color:var(--etch-dim);transition:background .12s,color .12s}
.lever:hover{background:var(--enamel-3);color:var(--etch)}
.lever .pip{position:relative;width:18px;height:8px;border-radius:4px;background:var(--groove);box-shadow:0 1px 1px rgba(0,0,0,.5) inset;flex:none;transition:background .15s}
.lever .pip::after{content:'';position:absolute;top:1px;left:1px;width:6px;height:6px;border-radius:3px;background:var(--ridge);transition:left .15s cubic-bezier(.2,.9,.3,1),background .15s,box-shadow .15s}
.lever:hover .pip::after{background:var(--etch-dim)}
.lever.on{color:var(--etch)}
.lever.on .pip{background:var(--enamel-3)}
.lever.on .pip::after{left:11px;background:var(--white-lamp);box-shadow:0 0 5px rgba(242,247,240,.6)}
.lv-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lv-count{font-family:var(--mono);font-size:10.5px;font-weight:500;color:var(--etch-faint);font-variant-numeric:tabular-nums}
.lever.on .lv-count{color:var(--etch-dim)}
.more{margin-top:4px}
.more summary{font-size:10px;letter-spacing:.16em;color:var(--etch-faint);cursor:pointer;padding:4px 6px}
.grp-note{font-size:10.5px;color:var(--etch-faint);padding:6px 6px 0;line-height:1.4}
.rail-clear{margin-top:18px}
.clear-btn{display:inline-block;padding:8px 14px;border:1px solid var(--ridge);border-radius:4px;
  font-size:10.5px;font-weight:700;letter-spacing:.16em;color:var(--etch-dim);transition:all .15s}
.clear-btn:hover{border-color:var(--amber);color:var(--amber)}
.rail-legend{margin-top:22px;padding:10px 6px 0;border-top:1px solid var(--groove);
  font-size:9.5px;letter-spacing:.1em;line-height:2;color:var(--etch-faint);font-weight:600}

/* ---- board ---- */
.board{min-width:0;padding:0 0 40px}
.board-head{display:flex;align-items:baseline;justify-content:space-between;padding:13px 22px 10px}
.bh-total{font-size:11px;font-weight:600;letter-spacing:.18em;color:var(--etch-dim)}
.bh-total b{font-family:var(--mono);font-size:14px;color:var(--etch);font-weight:600;letter-spacing:0}
.bh-sheet{font-family:var(--mono);font-size:10.5px;color:var(--etch-faint);letter-spacing:.08em}
table.line{width:100%;border-collapse:collapse}
.line th{position:sticky;top:0;z-index:2;background:var(--enamel-2);text-align:left;
  font-size:9.5px;font-weight:700;letter-spacing:.14em;color:var(--etch-faint);
  padding:7px 8px;border-bottom:1px solid var(--groove);box-shadow:0 -1px 0 var(--ridge) inset}
.line td{padding:0 8px;border-bottom:1px solid var(--groove);height:42px;vertical-align:middle}
.c-lamp{width:30px;text-align:center!important}
.c-co{width:170px}
.c-field{width:64px}
.c-loc{width:190px}
.c-grad{width:64px}
.c-cit{width:70px}
.c-seen{width:76px}
.c-throw{width:150px}
tr.block{transition:background .12s}
tr.block:hover,tr.block.cur{background:var(--enamel-2)}
tr.block.cur{box-shadow:2px 0 0 var(--amber) inset}
tr.block:focus-visible{outline:none;background:var(--enamel-2);box-shadow:2px 0 0 var(--amber) inset}
/* .fresh carries no wash: the amber lamp alone says "awaiting decision" — one signal per fact */
tr.closed td{opacity:.45}
tr.closed .c-title a{text-decoration:line-through;text-decoration-color:var(--etch-faint)}
.co{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--etch-dim);
  display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
.c-title{max-width:0}
.c-title a{font-size:14px;font-weight:500;color:var(--etch);display:block;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;text-underline-offset:3px}
.c-title a:hover{text-decoration:underline;text-decoration-color:var(--amber-soft)}
.code{display:inline-block;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;
  color:var(--etch-dim);border:1px solid var(--ridge);border-radius:3px;padding:2px 5px}
.c-loc{font-size:12px;color:var(--etch-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c-grad,.c-seen{font-family:var(--mono);font-size:11px;color:var(--etch-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.cit{font-family:var(--mono);font-size:9px;font-weight:600;letter-spacing:.05em;color:var(--etch-faint)}
.deadline{color:var(--etch-dim)}
.deadline.soon{color:var(--red)}
.deadline.past{color:var(--etch-faint)}
.m-meta{display:none}

/* ---- throws (status control) ---- */
.throws{display:inline-flex;gap:3px;opacity:.35;transition:opacity .15s}
tr.block:hover .throws,tr.block.cur .throws,tr.block:focus-within .throws,.throws:has(.on){opacity:1}
.throw{font-family:var(--mono);font-size:10px;font-weight:600;width:24px;height:24px;border-radius:3px;
  background:var(--groove);color:var(--etch-dim);border:1px solid var(--ridge);cursor:pointer;
  transition:all .12s}
.throw:hover{border-color:var(--etch-dim);color:var(--etch)}
.throw.on{background:var(--etch);color:var(--enamel-0);border-color:var(--etch);font-weight:700}
.throw.pending{animation:pend 0.7s ease-in-out infinite alternate}
@keyframes pend{from{opacity:.4}to{opacity:1}}

/* ---- dividers ---- */
tr.divider td{height:30px;padding:4px 22px;background:var(--enamel-1);border-bottom:1px solid var(--groove)}
tr.divider span{font-size:10px;font-weight:700;letter-spacing:.18em;color:var(--etch-faint)}
tr.new-div td{background:linear-gradient(90deg,rgba(255,176,0,.07),rgba(255,176,0,.01));border-bottom:1px solid rgba(255,176,0,.16)}
tr.new-div span{color:var(--amber-soft)}
.div-detail{margin-left:16px;font-family:var(--mono);letter-spacing:.1em!important;font-weight:500!important}

/* ---- empty state ---- */
.empty{padding:70px 20px;text-align:center}
.empty-head{font-size:18px;font-weight:700;letter-spacing:.2em;color:var(--etch-dim)}
.empty-sub{margin:10px 0 22px;font-size:13px;color:var(--etch-faint)}

/* ---- pagination / foot ---- */
.sheets{display:flex;align-items:center;justify-content:center;gap:18px;padding:22px 0 6px}
.sheet-btn{font-size:10.5px;font-weight:700;letter-spacing:.16em;padding:7px 13px;border:1px solid var(--ridge);border-radius:4px;color:var(--etch-dim);transition:all .15s}
a.sheet-btn:hover{border-color:var(--amber);color:var(--amber)}
.sheet-btn.off{opacity:.3}
.sheet-pos{font-family:var(--mono);font-size:11px;color:var(--etch-faint);letter-spacing:.08em}
.board-foot{text-align:center;font-family:var(--mono);font-size:10px;color:var(--etch-faint);letter-spacing:.06em;padding-top:14px}

/* ---- toast ---- */
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(80px);
  background:var(--enamel-3);border:1px solid var(--ridge);color:var(--etch);border-radius:5px;
  font-size:12px;padding:10px 18px;transition:transform .25s cubic-bezier(.2,.9,.3,1);z-index:50}
.toast.show{transform:translateX(-50%) translateY(0)}

/* ---- repack (the one authored motion: a filter throw resettles the whole line) ---- */
@media (prefers-reduced-motion:no-preference){
  tbody tr{animation:repack .22s cubic-bezier(.16,1,.3,1) backwards;animation-delay:330ms}
  ${Array.from({ length: 52 }, (_, i) => `tbody tr:nth-child(${i + 1}){animation-delay:${i * 6}ms}`).join("")}
}
@keyframes repack{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}

/* ---- mobile ---- */
@media (max-width:880px){
  .plate{flex-wrap:wrap;gap:12px;padding:12px 14px}
  .plate-counts{order:3;flex-basis:100%}
  .deck{grid-template-columns:1fr}
  .interlocking{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--groove);padding:12px 14px 16px}
  .scan input{font-size:16px}
  .rail-legend{display:none}
  .plate-count{padding:4px 8px}
  .pc-l{white-space:nowrap}
  .grp{margin-top:8px;padding-top:6px}
  .line thead{display:none}
  table.line,tbody,tr.block{display:block}
  tr.block{position:relative;padding:10px 14px 10px 38px;border-bottom:1px solid var(--groove)}
  tr.block td{display:none;border:0;height:auto;padding:0}
  tr.block td.c-lamp{display:block;position:absolute;left:14px;top:16px;width:auto}
  tr.block td.c-co,tr.block td.c-title,tr.block td.c-throw{display:block}
  .c-title{max-width:none}
  .c-title a{white-space:normal;font-size:14.5px;line-height:1.35}
  .m-meta{display:flex;gap:8px;align-items:center;margin-top:5px;flex-wrap:wrap}
  .m-meta .loc{font-size:11.5px;color:var(--etch-faint)}
  tr.block td.c-throw{margin-top:9px}
  .throws{opacity:1}
  tr.divider{display:block}
  tr.divider td{display:block}
  .board-foot{display:none}
}`;
}

// --- client js ----------------------------------------------------------------------------

function js(): string {
  return `
(function(){
  if(matchMedia('(max-width:880px)').matches){
    document.querySelectorAll('.grp[open]').forEach(function(d){d.removeAttribute('open')});
  }
  var KEYMAP={s:'saved',a:'applied',i:'interviewing',o:'offer',x:'rejected'};
  var rows=Array.prototype.slice.call(document.querySelectorAll('tr.block'));
  var cur=-1;
  var toast=document.getElementById('toast');var toastT;
  function say(msg){toast.textContent=msg;toast.classList.add('show');clearTimeout(toastT);toastT=setTimeout(function(){toast.classList.remove('show')},3500)}

  // Lamp classes mirror render-side lamp(): keep the two in sync.
  function lampClass(status,isFresh){
    if(status==='saved')return 'lamp lit-white';
    if(status==='applied'||status==='interviewing'||status==='offer')return 'lamp lit-green';
    if(status==='rejected')return 'lamp closed';
    return isFresh?'lamp lit-amber':'lamp';
  }
  function setStatus(tr,status){
    var id=tr.getAttribute('data-id');
    var btns=tr.querySelectorAll('.throw');
    var active=tr.querySelector('.throw.on');
    var next=(active&&active.getAttribute('data-status')===status)?null:status; // same key twice = clear
    btns.forEach(function(b){b.classList.add('pending')});
    fetch('/api/applications/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({status:next})})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
      .then(function(){
        btns.forEach(function(b){
          b.classList.remove('pending');
          var on=b.getAttribute('data-status')===next;
          b.classList.toggle('on',on);
          b.setAttribute('aria-pressed',on?'true':'false');
        });
        tr.classList.toggle('closed',next==='rejected');
        // amber "awaiting decision" wash lifts the moment a decision lands, returns on clear
        var isNew=tr.hasAttribute('data-new');
        tr.classList.toggle('fresh',isNew&&!next);
        tr.querySelector('.lamp').className=lampClass(next,isNew&&!next);
      })
      .catch(function(){
        btns.forEach(function(b){b.classList.remove('pending')});
        say('SIGNAL FAILURE — status not saved. Check the server and retry.');
      });
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest('.throw');
    if(b){e.preventDefault();setStatus(b.closest('tr.block'),b.getAttribute('data-status'))}
  });
  function focusRow(i){
    if(cur>=0&&rows[cur])rows[cur].classList.remove('cur');
    cur=Math.max(0,Math.min(rows.length-1,i));
    if(rows[cur]){rows[cur].classList.add('cur');rows[cur].scrollIntoView({block:'nearest'})}
  }
  document.addEventListener('keydown',function(e){
    if(e.target.matches('input,textarea,select')||e.metaKey||e.ctrlKey||e.altKey)return;
    var k=e.key.toLowerCase();
    if(k==='j'){e.preventDefault();focusRow(cur+1)}
    else if(k==='k'){e.preventDefault();focusRow(cur-1)}
    else if(k==='enter'&&cur>=0){var a=rows[cur].querySelector('.c-title a');if(a)window.open(a.href,'_blank')}
    else if(KEYMAP[k]&&cur>=0){e.preventDefault();setStatus(rows[cur],KEYMAP[k])}
    else if(k==='u'&&cur>=0){e.preventDefault();var on=rows[cur].querySelector('.throw.on');if(on)setStatus(rows[cur],on.getAttribute('data-status'))}
  });
  // Row click (not on a link/button) selects it for keyboard work.
  document.addEventListener('mousedown',function(e){
    var tr=e.target.closest('tr.block');
    if(tr&&!e.target.closest('a,.throw'))focusRow(rows.indexOf(tr));
  });
})();`;
}
