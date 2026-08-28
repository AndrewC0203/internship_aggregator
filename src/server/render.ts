// SSR renderer for the search page — the Terminal Board world (see the direction contract
// in the emitted <body>). Pure function: (params, result) -> HTML string. All CSS/JS inline;
// the only external request is the single self-hosted Chivo Mono woff2.
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
  // Any filter change resets to page 1 unless the override IS the page.
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

// Authored status marks — one 10px stroke system, drawn not borrowed. State is a mark plus a
// code word, never a hue: the page's one chromatic law is blue = NEW, and everything else
// reads in pure monochrome (weight + mark). Keep in sync with client-side statusCellHTML().
const MARK_HELD = `<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
const MARK_FLIGHT = `<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="currentColor"/></svg>`;
const MARK_REJ = `<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4"/></svg>`;

function statusCell(status: string | null, isNew: boolean): string {
  if (status === "saved") return `<span class="st held">${MARK_HELD}HELD</span>`;
  if (status === "applied") return `<span class="st flight">${MARK_FLIGHT}APP</span>`;
  if (status === "interviewing") return `<span class="st flight">${MARK_FLIGHT}INT</span>`;
  if (status === "offer") return `<span class="st flight">${MARK_FLIGHT}OFF</span>`;
  if (status === "rejected") return `<span class="st rej">${MARK_REJ}REJ</span>`;
  if (isNew) return `<span class="st new">NEW</span>`;
  return `<span class="st idle">—</span>`;
}

function setControl(id: number, current: string | null): string {
  const opts: Array<[string, string, string]> = [
    ["saved", "S", "Save for later"],
    ["applied", "A", "Mark applied"],
    ["interviewing", "I", "Mark interviewing"],
    ["offer", "O", "Mark offer"],
    ["rejected", "X", "Mark rejected"],
  ];
  const btns = opts
    .map(
      ([val, key, tip]) =>
        `<button class="key${current === val ? " on" : ""}" data-id="${id}" data-status="${val}" title="${tip}" aria-pressed="${current === val}">${key}</button>`,
    )
    .join("");
  return `<span class="keys" role="group" aria-label="application status">${btns}</span>`;
}

function row(r: SearchResult["rows"][number], idx: number): string {
  const deadlineDelta = r.applicationDeadline
    ? r.applicationDeadline.getTime() - Date.now()
    : null;
  // Urgency is weight, not hue: a live deadline inside 14 days sets bold white; a passed
  // deadline drops to tertiary ink. The monochrome law leaves red no job on this page.
  const deadlineSoon = deadlineDelta !== null && deadlineDelta > 0 && deadlineDelta < 14 * 86400_000;
  const deadlinePassed = deadlineDelta !== null && deadlineDelta <= 0;
  const meta: string[] = [];
  if (r.csField) meta.push(`<span class="code">${FIELD_LABEL[r.csField] ?? r.csField}</span>`);
  const grad = gradWindow(r.gradYearMin, r.gradYearMax);
  const isFresh = r.isNew && !r.status;
  return `<tr class="pos${r.status === "rejected" ? " rej-row" : ""}" data-id="${r.id}"${r.isNew ? " data-new" : ""} tabindex="0">
<td class="c-idx"><span class="idx${isFresh ? " new" : ""}">${String(idx).padStart(3, "0")}</span></td>
<td class="c-st">${statusCell(r.status, r.isNew)}</td>
<td class="c-co"><span class="co" title="${esc(r.company)}">${esc(r.company)}</span></td>
<td class="c-title"><a href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(r.title.trim())} — opens at ${esc(r.company)}">${esc(r.title.trim())}</a>
  <span class="m-meta">${meta.join("")}${r.location ? `<span class="loc">${esc(r.location)}</span>` : ""}${grad ? `<span class="loc">${grad}</span>` : ""}${r.citizenshipStatus && r.citizenshipStatus !== "unknown" ? `<span class="loc">${CITIZEN_LABEL[r.citizenshipStatus] ?? ""}</span>` : ""}</span></td>
<td class="c-field">${r.csField ? `<span class="code">${FIELD_LABEL[r.csField] ?? r.csField}</span>` : ""}</td>
<td class="c-loc" title="${esc(r.location ?? "")}">${esc((r.location ?? "").length > 26 ? (r.location ?? "").slice(0, 25) + "…" : (r.location ?? ""))}</td>
<td class="c-grad">${grad}</td>
<td class="c-cit">${r.citizenshipStatus && r.citizenshipStatus !== "unknown" ? `<span class="cit">${CITIZEN_LABEL[r.citizenshipStatus] ?? ""}</span>` : ""}</td>
<td class="c-seen">${r.applicationDeadline ? `<span class="deadline${deadlineSoon ? " soon" : ""}${deadlinePassed ? " past" : ""}" title="application deadline">${deadlinePassed ? "CLOSED" : "DUE"} ${fmtDate(r.applicationDeadline)}</span>` : fmtDate(r.firstSeenAt)}</td>
<td class="c-set">${setControl(r.id, r.status)}</td>
</tr>`;
}

// --- screener fragments -------------------------------------------------------------------

// Filter rows: an authored square mark + label + count. Selection is weight and fill, not a
// new hue — the active square fills white and the label sets heavier.
function frow(href: string, label: string, count: number | undefined, on: boolean): string {
  return `<a class="frow${on ? " on" : ""}" href="${href}" aria-current="${on ? "true" : "false"}">
<svg class="fbox" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2"/></svg><span class="f-label">${label}</span><span class="f-count">${count ?? 0}</span></a>`;
}

const CHEV = `<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function railGroup(title: string, body: string, open = true): string {
  return `<details class="grp"${open ? " open" : ""}><summary>${CHEV}${title}</summary>${body}</details>`;
}

// --- page ---------------------------------------------------------------------------------

export function renderPage(p: SearchParams, res: SearchResult): string {
  const totalSheets = Math.max(1, Math.ceil(res.total / res.per));
  const anyFilter =
    !!(p.q || p.type || p.field || p.country || p.state || p.gradYear || p.status || p.newOnly);

  // Ticker items: overall corpus split by type under everything EXCEPT type (facet counts).
  const ticker = Object.entries(TYPE_LABEL)
    .map(([val, label]) => {
      const on = p.type?.includes(val) ?? false;
      return `<a class="tick${on ? " on" : ""}" href="${qs(p, { type: toggled(p.type, val) })}" aria-current="${on ? "true" : "false"}">
<span class="tk-l">${label}</span><span class="tk-n">${res.facets.type[val] ?? 0}</span></a>`;
    })
    .join("");

  // Screener groups.
  const typeRows = Object.entries(TYPE_LABEL)
    .map(([val, label]) =>
      frow(qs(p, { type: toggled(p.type, val) }), label, res.facets.type[val], p.type?.includes(val) ?? false),
    )
    .join("");
  const fieldRows = Object.entries(FIELD_LABEL)
    .map(([val, label]) =>
      frow(qs(p, { field: toggled(p.field, val) }), label, res.facets.field[val], p.field?.includes(val) ?? false),
    )
    .join("");
  const stateEntries = Object.entries(res.facets.state);
  const stateRows = stateEntries
    .slice(0, 12)
    .map(([val, count]) =>
      frow(qs(p, { state: toggled(p.state, val) }), val, count, p.state?.includes(val) ?? false),
    )
    .join("");
  const stateMore = stateEntries
    .slice(12)
    .map(([val, count]) =>
      frow(qs(p, { state: toggled(p.state, val) }), val, count, p.state?.includes(val) ?? false),
    )
    .join("");
  const countryRows = Object.entries(res.facets.country)
    .slice(0, 8)
    .map(([val, count]) =>
      frow(qs(p, { country: toggled(p.country, val) }), val, count, p.country?.includes(val) ?? false),
    )
    .join("");
  const statusRows = Object.entries(STATUS_LABEL)
    .map(([val, label]) =>
      frow(qs(p, { status: toggled(p.status, val) }), label, res.facets.status[val], p.status?.includes(val) ?? false),
    )
    .join("");
  const years = [2026, 2027, 2028, 2029];
  const yearRows = years
    .map((y) => {
      const on = p.gradYear === y;
      return `<a class="frow${on ? " on" : ""}" href="${qs(p, { gradYear: on ? null : String(y) })}" aria-current="${on ? "true" : "false"}"><svg class="fbox" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2"/></svg><span class="f-label">CLASS OF ’${String(y).slice(2)}</span></a>`;
    })
    .join("");
  const sorts: Array<[SearchParams["sort"], string]> = [
    ["first_seen", "FIRST SEEN"], ["published", "PUBLISHED"], ["company", "COMPANY"],
  ];
  const sortRows = sorts
    .map(([val, label]) => {
      const on = (p.sort ?? "first_seen") === val;
      return `<a class="frow${on ? " on" : ""}" href="${qs(p, { sort: val === "first_seen" ? null : (val as string) })}" aria-current="${on ? "true" : "false"}"><svg class="fbox" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2"/></svg><span class="f-label">${label}</span></a>`;
    })
    .join("");

  // Board rows with NEW / EARLIER dividers (only meaningful on the freshness sort).
  // Row index numbers count absolute position in the result set, so page 2 starts at 051 —
  // the fixed margin column that makes j/k keyboard position legible.
  let rowsHtml = "";
  if (res.rows.length === 0) {
    rowsHtml = `<tr class="empty-row"><td colspan="10">
<div class="empty"><p class="empty-head">NO MATCHES</p>
<p class="empty-sub">Nothing on the board matches these filters.</p>
${anyFilter ? `<a class="clear-btn" href="/">CLEAR FILTERS</a>` : ""}</div></td></tr>`;
  } else {
    const showDividers = (p.sort ?? "first_seen") === "first_seen" && !p.newOnly;
    const baseIdx = (res.page - 1) * res.per;
    let inNew = false;
    let openedEarlier = false;
    const parts: string[] = [];
    for (let i = 0; i < res.rows.length; i++) {
      const r = res.rows[i];
      if (showDividers && i === 0 && r.isNew) {
        parts.push(`<tr class="divider new-div"><td colspan="10"><span>NEW</span><span class="div-detail">${res.newCount} IN ${NEW_WINDOW_DAYS} DAYS</span></td></tr>`);
        inNew = true;
      }
      if (showDividers && inNew && !r.isNew && !openedEarlier) {
        parts.push(`<tr class="divider"><td colspan="10"><span>EARLIER</span></td></tr>`);
        openedEarlier = true;
      }
      parts.push(row(r, baseIdx + i + 1));
    }
    rowsHtml = parts.join("\n");
  }

  const pageHref = (n: number) => qs(p, { page: n <= 1 ? null : String(n) });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CS Opportunities — Board</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='%23050507'/><rect x='5' y='5' width='6' height='6' fill='%234D9FFF'/></svg>`)}">
<style>${css()}</style>
</head>
<body>
<!--
THESIS: A job search run as a market terminal — listings are instruments on a watchlist, the
pipeline is the portfolio, NEW is the movers column. Refuses the white-card job board, in
near-total monochrome: the market metaphor is structural (density, index column, tick motion),
never literal (no fake charts, no gain/loss color).
OWN-WORLD: True-black ruled data surfaces (#050507/#0C0D11/#13151B), white-to-gray inks,
hairline #1E2129 rules, Chivo Mono for every figure and label, system sans for running words.
One law per hue: #4D9FFF blue may only ever mean NEW. Status is a mark + code word (HELD/APP/
INT/OFF/REJ), never a hue; selection is weight and monochrome inversion. Nothing glides —
every state change snaps and settles like a price tick.
STORY: The owner opens the board, reads the blue NEW figure and the NEW band, narrows with
the screener, and marks each position — save, apply, strike — without leaving the keyboard.
FIRST VIEWPORT: Full-width tape: wordmark left, per-type index ticker center, the oversized
blue NEW figure right (never shrinks). Screener rail left (~240px); the board filling the
rest — numbered index column, status codes, dense ruled rows. Primary action = the row.
FORM: Market-data terminal (watchlist grammar), monochrome rendition chosen from the
variation round; candidate 3 of 7 on my grounded list; seed key ff70fa62.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the
verdict, DESIGN.md, and every shipping raster carrying its provenance.
-->
<a class="skip" href="#board">Skip to listings</a>
<header class="tape">
  <div class="brand">
    <h1>CS OPPORTUNITIES</h1>
    <span class="brand-sub">EARLY-CAREER BOARD</span>
  </div>
  <nav class="ticker" aria-label="listings by type">${ticker}</nav>
  <a class="new-block${p.newOnly ? " on" : ""}" href="${qs(p, { new: p.newOnly ? null : "1" })}" title="show only new listings" aria-current="${p.newOnly ? "true" : "false"}">
    <span class="nb-n">${res.newCount}</span>
    <span class="nb-l">NEW · ${NEW_WINDOW_DAYS}D</span>
  </a>
</header>
<div class="deck">
<aside class="screener" aria-label="filters">
  <form method="get" action="/" class="query">
    <input type="search" name="q" value="${esc(p.q ?? "")}" placeholder="SEARCH TITLE / COMPANY" aria-label="search title or company">
    ${p.type ? `<input type="hidden" name="type" value="${p.type.join(",")}">` : ""}
    ${p.field ? `<input type="hidden" name="field" value="${p.field.join(",")}">` : ""}
    ${p.state ? `<input type="hidden" name="state" value="${p.state.join(",")}">` : ""}
    ${p.country ? `<input type="hidden" name="country" value="${p.country.join(",")}">` : ""}
    ${p.status ? `<input type="hidden" name="status" value="${p.status.join(",")}">` : ""}
    ${p.gradYear ? `<input type="hidden" name="gradYear" value="${p.gradYear}">` : ""}
    ${p.newOnly ? `<input type="hidden" name="new" value="1">` : ""}
    ${p.sort && p.sort !== "first_seen" ? `<input type="hidden" name="sort" value="${p.sort}">` : ""}
  </form>
  ${railGroup("TYPE", `<div class="frows">${typeRows}</div>`)}
  ${railGroup("FIELD", `<div class="frows">${fieldRows}</div>`)}
  ${railGroup("US STATE", `<div class="frows">${stateRows}</div>${stateMore ? `<details class="more"><summary>ALL STATES</summary><div class="frows">${stateMore}</div></details>` : ""}`)}
  ${railGroup("COUNTRY", `<div class="frows">${countryRows}</div>`, false)}
  ${railGroup("CLASS YEAR", `<div class="frows" role="group" aria-label="class year">${yearRows}</div><p class="grp-note">Listings stating no window stay visible.</p>`, false)}
  ${railGroup("MY PIPELINE", `<div class="frows">${statusRows}</div>`, false)}
  ${railGroup("ORDER", `<div class="frows" role="group" aria-label="sort">${sortRows}</div>`, false)}
  ${anyFilter ? `<a class="clear-btn rail-clear" href="/">CLEAR FILTERS</a>` : ""}
</aside>
<main class="board" id="board">
  <div class="board-head">
    <span class="bh-total"><b>${res.total}</b> LISTINGS</span>
    <span class="bh-sheet">PAGE ${res.page} / ${totalSheets}</span>
  </div>
  <table class="grid">
    <thead><tr>
      <th class="c-idx" scope="col">#</th>
      <th class="c-st" scope="col">STATUS</th>
      <th class="c-co" scope="col">COMPANY</th>
      <th class="c-title" scope="col">POSITION</th>
      <th class="c-field" scope="col">FIELD</th>
      <th class="c-loc" scope="col">LOCATION</th>
      <th class="c-grad" scope="col" title="stated graduation window">CLASS</th>
      <th class="c-cit" scope="col" title="citizenship / sponsorship">CIT</th>
      <th class="c-seen" scope="col" title="first seen (or deadline)">SEEN</th>
      <th class="c-set" scope="col" title="set application status">SET</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <nav class="sheets" aria-label="pagination">
    ${res.page > 1 ? `<a class="sheet-btn" href="${pageHref(res.page - 1)}">PREV</a>` : `<span class="sheet-btn off">PREV</span>`}
    <span class="sheet-pos">PAGE ${res.page} / ${totalSheets}</span>
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
@font-face{font-family:'Chivo Mono';src:url('/fonts/chivo-mono.woff2') format('woff2');font-weight:100 900;font-display:swap}
:root{
  --bg0:#050507; --bg1:#0C0D11; --bg2:#13151B; --bg3:#1A1D25;
  --line:#1E2129; --line-2:#2A2E38;
  --ink:#ECEDEF; --ink-2:#9DA2AD; --ink-3:#757B86;
  --blue:#4D9FFF;
  --sans:system-ui,-apple-system,'Segoe UI',sans-serif; --mono:'Chivo Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg0)}
body{font-family:var(--sans);color:var(--ink);font-size:14px;line-height:1.45;min-height:100vh}
::selection{background:var(--ink);color:var(--bg0)}
input{caret-color:var(--ink)}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:1px}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:var(--bg0)}
*::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:5px;border:2px solid var(--bg0)}
a{color:inherit;text-decoration:none}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.skip{position:absolute;left:-9999px;top:0;background:var(--ink);color:var(--bg0);padding:8px 14px;font-weight:700;z-index:99}
.skip:focus{left:8px}

/* ---- tape (header) ---- */
.tape{display:flex;align-items:stretch;gap:0;background:var(--bg1);border-bottom:1px solid var(--line-2)}
.brand{padding:14px 22px 12px;border-right:1px solid var(--line);min-width:210px}
.brand h1{font-family:var(--mono);font-size:13px;font-weight:700;letter-spacing:.18em;white-space:nowrap}
.brand-sub{display:block;font-family:var(--mono);font-size:9px;font-weight:500;letter-spacing:.22em;color:var(--ink-3);margin-top:3px}
.ticker{display:flex;flex:1;min-width:0;overflow-x:auto;font-family:var(--mono)}
.tick{display:flex;flex-direction:column;justify-content:center;gap:2px;padding:10px 18px;border-right:1px solid var(--line);white-space:nowrap}
.tick:hover{background:var(--bg2)}
.tk-l{font-size:9px;font-weight:500;letter-spacing:.14em;color:var(--ink-3)}
.tk-n{font-size:15px;font-weight:500;color:var(--ink-2);font-variant-numeric:tabular-nums}
.tick.on{background:var(--bg2);box-shadow:0 -2px 0 var(--ink) inset}
.tick.on .tk-l{color:var(--ink-2);font-weight:700}
.tick.on .tk-n{color:var(--ink);font-weight:700}
/* The one shouting figure: the NEW count is the page's single oversized element and never
   shrinks. Blue's only job on this page. */
.new-block{display:flex;align-items:baseline;gap:10px;padding:0 22px;border-left:1px solid var(--line);font-family:var(--mono)}
.new-block:hover{background:var(--bg2)}
.nb-n{font-size:40px;font-weight:600;line-height:64px;color:var(--blue);font-variant-numeric:tabular-nums}
.nb-l{font-size:9px;font-weight:600;letter-spacing:.18em;color:var(--ink-3)}
.new-block.on{box-shadow:0 -2px 0 var(--blue) inset;background:var(--bg2)}
.new-block.on .nb-l{color:var(--ink);font-weight:700}

/* ---- deck ---- */
.deck{display:grid;grid-template-columns:240px 1fr;gap:0;align-items:start}

/* ---- screener rail ---- */
.screener{position:sticky;top:0;max-height:100vh;overflow-y:auto;padding:16px 14px 28px;
  background:var(--bg1);border-right:1px solid var(--line-2)}
.query input{width:100%;background:var(--bg0);border:1px solid var(--line-2);color:var(--ink);
  font-family:var(--mono);font-size:11.5px;padding:9px 11px;letter-spacing:.02em}
.query input::placeholder{color:var(--ink-2)}
.grp{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}
.grp summary{cursor:pointer;list-style:none;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.2em;color:var(--ink-2);
  display:flex;align-items:center;gap:7px;padding:2px 4px;user-select:none}
.grp summary .chev{width:9px;height:9px;color:var(--ink-3);flex:none}
.grp[open]>summary .chev{transform:rotate(90deg)}
.grp summary::-webkit-details-marker{display:none}
.frows{display:flex;flex-direction:column;margin-top:6px}
.frow{display:flex;align-items:center;gap:9px;padding:5px 6px;font-size:12px;font-weight:500;
  letter-spacing:.04em;color:var(--ink-2);font-family:var(--mono)}
.frow:hover{background:var(--bg2);color:var(--ink)}
.frow .fbox{width:10px;height:10px;color:var(--ink-3);flex:none}
.frow:hover .fbox{color:var(--ink-2)}
.frow.on{color:var(--ink);font-weight:700}
.frow.on .fbox{color:var(--ink)}
.f-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.f-count{font-size:10.5px;font-weight:500;color:var(--ink-3);font-variant-numeric:tabular-nums}
.frow.on .f-count{color:var(--ink-2)}
.more{margin-top:4px}
.more summary{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;color:var(--ink-3);cursor:pointer;padding:4px 6px;list-style:none}
.more summary::-webkit-details-marker{display:none}
.grp-note{font-size:11px;color:var(--ink-3);padding:6px 6px 0;line-height:1.4}
.rail-clear{margin-top:18px}
.clear-btn{display:inline-block;padding:8px 14px;border:1px solid var(--line-2);
  font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.16em;color:var(--ink-2)}
.clear-btn:hover{border-color:var(--ink);color:var(--ink)}

/* ---- board ---- */
.board{min-width:0;padding:0 0 40px}
.board-head{display:flex;align-items:baseline;justify-content:space-between;padding:13px 22px 10px}
.bh-total{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.18em;color:var(--ink-2)}
.bh-total b{font-size:14px;color:var(--ink);font-weight:600;letter-spacing:0}
.bh-sheet{font-family:var(--mono);font-size:10px;color:var(--ink-3);letter-spacing:.08em}
table.grid{width:100%;border-collapse:collapse}
.grid th{position:sticky;top:0;z-index:2;background:var(--bg1);text-align:left;
  font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.14em;color:var(--ink-3);
  padding:7px 8px;border-bottom:1px solid var(--line-2)}
.grid td{padding:0 8px;border-bottom:1px solid var(--line);height:40px;vertical-align:middle}
.c-idx{width:46px}
.c-st{width:74px}
.c-co{width:160px}
.c-field{width:60px}
.c-loc{width:184px}
.c-grad{width:62px}
.c-cit{width:68px}
.c-seen{width:80px}
.c-set{width:148px}
tr.pos:hover,tr.pos.cur{background:var(--bg2)}
tr.pos:focus-visible{outline:none;background:var(--bg2)}
/* Keyboard cursor: the index cell inverts — a monochrome flip, the terminal's cursor cell */
.idx{display:inline-block;font-family:var(--mono);font-size:10px;font-weight:500;color:var(--ink-3);
  font-variant-numeric:tabular-nums;padding:2px 4px}
.idx.new{color:var(--blue);font-weight:700}
tr.pos.cur .idx,tr.pos:focus-visible .idx{background:var(--ink);color:var(--bg0);font-weight:700}
tr.rej-row td{opacity:.4}
tr.rej-row .c-title a{text-decoration:line-through;text-decoration-color:var(--ink-3)}
.co{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);
  display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.c-title{max-width:0}
.c-title a{font-size:13.5px;font-weight:500;color:var(--ink);display:block;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;text-underline-offset:3px}
.c-title a:hover{text-decoration:underline;text-decoration-color:var(--ink-2)}
.code{display:inline-block;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;
  color:var(--ink-2);border:1px solid var(--line-2);padding:2px 5px}
.c-loc{font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c-grad,.c-seen{font-family:var(--mono);font-size:11px;color:var(--ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.cit{font-family:var(--mono);font-size:9px;font-weight:600;letter-spacing:.05em;color:var(--ink-3)}
.deadline{color:var(--ink-2)}
.deadline.soon{color:var(--ink);font-weight:700}
.deadline.past{color:var(--ink-3)}
.m-meta{display:none}

/* ---- status cell ---- */
.st{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em}
.st .mk{width:10px;height:10px;flex:none}
.st.new{color:var(--blue);font-weight:700}
.st.held{color:var(--ink-2)}
.st.flight{color:var(--ink)}
.st.rej{color:var(--ink-3)}
.st.idle{color:var(--ink-3);font-weight:400}

/* ---- set keys (status control) ---- */
.keys{display:inline-flex;gap:3px;opacity:.35}
tr.pos:hover .keys,tr.pos.cur .keys,tr.pos:focus-within .keys,.keys:has(.on){opacity:1}
.key{font-family:var(--mono);font-size:10px;font-weight:600;width:22px;height:22px;
  background:var(--bg0);color:var(--ink-2);border:1px solid var(--line-2);cursor:pointer}
.key:hover{border-color:var(--ink-2);color:var(--ink)}
.key.on{background:var(--ink);color:var(--bg0);border-color:var(--ink);font-weight:700}
.key.pending{animation:pend .5s steps(2,end) infinite}
@keyframes pend{0%{opacity:.35}100%{opacity:1}}

/* ---- dividers ---- */
tr.divider td{height:28px;padding:4px 22px;background:var(--bg1);border-bottom:1px solid var(--line)}
tr.divider span{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.2em;color:var(--ink-3)}
tr.new-div td{border-bottom:1px solid var(--blue);background:var(--bg1)}
tr.new-div span{color:var(--blue)}
.div-detail{margin-left:16px;letter-spacing:.1em!important;font-weight:500!important;color:var(--ink-3)!important}

/* ---- empty state ---- */
.empty{padding:70px 20px;text-align:center}
.empty-head{font-family:var(--mono);font-size:18px;font-weight:700;letter-spacing:.24em;color:var(--ink-2)}
.empty-sub{margin:10px 0 22px;font-size:13px;color:var(--ink-2)}

/* ---- pagination / foot ---- */
.sheets{display:flex;align-items:center;justify-content:center;gap:18px;padding:22px 0 6px}
.sheet-btn{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.16em;padding:7px 13px;border:1px solid var(--line-2);color:var(--ink-2)}
a.sheet-btn:hover{border-color:var(--ink);color:var(--ink)}
.sheet-btn.off{opacity:.3}
.sheet-pos{font-family:var(--mono);font-size:11px;color:var(--ink-3);letter-spacing:.08em;font-variant-numeric:tabular-nums}
.board-foot{text-align:center;font-family:var(--mono);font-size:10px;color:var(--ink-3);letter-spacing:.06em;padding-top:14px}

/* ---- toast ---- */
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);
  background:var(--bg3);border:1px solid var(--line-2);color:var(--ink);
  font-size:12px;padding:10px 18px;z-index:50;visibility:hidden}
.toast.show{visibility:visible;animation:blink .18s steps(2,end)}
@keyframes blink{0%{opacity:0}100%{opacity:1}}

/* ---- feed-connect (the one authored motion: rows snap in like a feed catching up).
   Nothing glides — steps(1) means each row appears whole, staggered down the board. ---- */
@media (prefers-reduced-motion:no-preference){
  tbody tr{animation:snapin .01s steps(1,end) backwards;animation-delay:420ms}
  ${Array.from({ length: 52 }, (_, i) => `tbody tr:nth-child(${i + 1}){animation-delay:${i * 8}ms}`).join("")}
  tr.pos.ticked{animation:tick .24s steps(2,end)}
}
@keyframes snapin{from{opacity:0}to{opacity:1}}
@keyframes tick{0%{background:var(--bg3)}100%{background:transparent}}

/* ---- mobile ---- */
@media (max-width:880px){
  .tape{flex-wrap:wrap}
  .brand{min-width:0;flex:1;border-right:0}
  .new-block{order:2}
  .ticker{order:3;flex-basis:100%;border-top:1px solid var(--line)}
  .deck{grid-template-columns:1fr}
  .screener{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line-2);padding:12px 14px 16px}
  .query input{font-size:16px}
  .grp{margin-top:8px;padding-top:6px}
  .grid thead{display:none}
  table.grid,tbody,tr.pos{display:block}
  tr.pos{position:relative;padding:10px 14px 10px 14px;border-bottom:1px solid var(--line)}
  tr.pos td{display:none;border:0;height:auto;padding:0}
  tr.pos td.c-st{display:block;position:absolute;right:14px;top:12px;width:auto}
  tr.pos td.c-co,tr.pos td.c-title,tr.pos td.c-set{display:block}
  .c-title{max-width:none}
  .c-title a{white-space:normal;font-size:14px;line-height:1.35;padding-right:64px}
  .co{max-width:none;padding-right:64px}
  .m-meta{display:flex;gap:8px;align-items:center;margin-top:5px;flex-wrap:wrap}
  .m-meta .loc{font-size:11px;color:var(--ink-3);font-family:var(--mono)}
  tr.pos td.c-set{margin-top:9px}
  .keys{opacity:1}
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
  var rows=Array.prototype.slice.call(document.querySelectorAll('tr.pos'));
  var cur=-1;
  var toast=document.getElementById('toast');var toastT;
  function say(msg){toast.textContent=msg;toast.classList.add('show');clearTimeout(toastT);toastT=setTimeout(function(){toast.classList.remove('show')},3500)}

  // Status cell markup mirrors render-side statusCell(): keep the two in sync.
  var MK_HELD='<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  var MK_FLIGHT='<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="currentColor"/></svg>';
  var MK_REJ='<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4"/></svg>';
  function statusCellHTML(status,isNew){
    if(status==='saved')return '<span class="st held">'+MK_HELD+'HELD</span>';
    if(status==='applied')return '<span class="st flight">'+MK_FLIGHT+'APP</span>';
    if(status==='interviewing')return '<span class="st flight">'+MK_FLIGHT+'INT</span>';
    if(status==='offer')return '<span class="st flight">'+MK_FLIGHT+'OFF</span>';
    if(status==='rejected')return '<span class="st rej">'+MK_REJ+'REJ</span>';
    if(isNew)return '<span class="st new">NEW</span>';
    return '<span class="st idle">—</span>';
  }
  function setStatus(tr,status){
    var id=tr.getAttribute('data-id');
    var btns=tr.querySelectorAll('.key');
    var active=tr.querySelector('.key.on');
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
        tr.classList.toggle('rej-row',next==='rejected');
        var isNew=tr.hasAttribute('data-new');
        tr.querySelector('.c-st').innerHTML=statusCellHTML(next,isNew&&!next);
        var idx=tr.querySelector('.idx');
        if(idx)idx.classList.toggle('new',isNew&&!next);
        // the tick: a committed write flashes and settles, like a price update
        tr.classList.remove('ticked');void tr.offsetWidth;tr.classList.add('ticked');
      })
      .catch(function(){
        btns.forEach(function(b){b.classList.remove('pending')});
        say('WRITE FAILED — status not saved. Check the server and retry.');
      });
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest('.key');
    if(b){e.preventDefault();setStatus(b.closest('tr.pos'),b.getAttribute('data-status'))}
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
    else if(k==='u'&&cur>=0){e.preventDefault();var on=rows[cur].querySelector('.key.on');if(on)setStatus(rows[cur],on.getAttribute('data-status'))}
  });
  // Row click (not on a link/button) selects it for keyboard work.
  document.addEventListener('mousedown',function(e){
    var tr=e.target.closest('tr.pos');
    if(tr&&!e.target.closest('a,.key'))focusRow(rows.indexOf(tr));
  });
})();`;
}
