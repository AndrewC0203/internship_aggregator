// SSR renderer for the search page — the Terminal Board world (see the direction contract
// in the emitted <body>). Pure function: (params, result) -> HTML string. All CSS/JS inline;
// the only external request is the single self-hosted Chivo Mono woff2.
import type { SearchParams, SearchResult } from "./search.js";
import { NEW_WINDOW_DAYS } from "./search.js";

export const esc = (s: string): string =>
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
export const WORKPLACE_LABEL: Record<string, string> = {
  onsite: "ONSITE", remote: "REMOTE", hybrid: "HYBRID",
};
const STATUS_LABEL: Record<string, string> = {
  none: "UNTOUCHED", saved: "SAVED", applied: "APPLIED",
  interviewing: "INTERVIEW", offer: "OFFER", rejected: "REJECTED",
};
// Same qualitative-only rule rank.ts's band() has always enforced — cosine never
// rendered as a percentage.
const FIT_BAND_LABEL: Record<"strong" | "good" | "fair", string> = {
  strong: "STRONG FIT", good: "GOOD FIT", fair: "FIT",
};
const CITIZEN_LABEL: Record<string, string> = {
  us_citizen_required: "USC REQ", no_sponsorship: "NO SPON", sponsorship_available: "SPON OK",
};
// Country chips display names, not ISO codes: raw alpha-2 collides with USPS state codes in
// the rail one group up (CA Canada/California, IN India/Indiana, MA Morocco/Massachusetts).
// The stored data stays ISO alpha-2; unmapped codes fall back to the code itself.
const COUNTRY_LABEL: Record<string, string> = {
  US: "USA", GB: "UK", CA: "CANADA", BR: "BRAZIL", SG: "SINGAPORE", IN: "INDIA",
  NL: "NETHERLANDS", HK: "HONG KONG", KR: "S. KOREA", DE: "GERMANY", FR: "FRANCE",
  CN: "CHINA", ES: "SPAIN", NZ: "NEW ZEALAND", AU: "AUSTRALIA", IE: "IRELAND",
  MX: "MEXICO", TW: "TAIWAN", JP: "JAPAN", PL: "POLAND", CO: "COLOMBIA", AE: "UAE",
  DK: "DENMARK", HU: "HUNGARY", SE: "SWEDEN", IL: "ISRAEL", CH: "SWITZERLAND",
  VN: "VIETNAM", PE: "PERU", RS: "SERBIA", CZ: "CZECHIA", BG: "BULGARIA",
  AR: "ARGENTINA", TH: "THAILAND", IT: "ITALY", ID: "INDONESIA", PT: "PORTUGAL",
  ZA: "S. AFRICA", MY: "MALAYSIA", TR: "TÜRKIYE", NG: "NIGERIA", GR: "GREECE",
  CL: "CHILE", PH: "PHILIPPINES", NO: "NORWAY", BE: "BELGIUM", UA: "UKRAINE",
  PK: "PAKISTAN", RO: "ROMANIA", SI: "SLOVENIA", AT: "AUSTRIA", CR: "COSTA RICA",
  PA: "PANAMA", FI: "FINLAND", LT: "LITHUANIA", NP: "NEPAL", BD: "BANGLADESH",
  MA: "MOROCCO", EG: "EGYPT", HR: "CROATIA", LK: "SRI LANKA", GE: "GEORGIA",
};

// Only completed_required gets a badge (Decision 24): it's the one degree status that
// contradicts an "internship" label and should warn the reader. pursuing/unknown/null are
// the expected state for student-facing roles — badging them would be noise on every row.
const degreeBadge = (s: string | null): string =>
  s === "completed_required"
    ? `<span class="cit" title="posting requires an already-completed degree">DEG REQ</span>`
    : "";

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
  if (p.workplace) base.workplace = p.workplace.join(",");
  if (p.selective) base.selective = "1";
  if (p.newOnly) base.new = "1";
  // Always carried explicitly, never inferred as "the default" — what counts as default
  // depends on whether ranking is active (hasProfile), which qs() doesn't know here. p.sort
  // is resolved to a concrete value by runSearch() before render, so this is always exact.
  if (p.sort) base.sort = p.sort;
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

// New = a blue diamond, not a repeated word: with a young corpus the word stamped 50 times
// per sheet was pure noise; the divider band and header figure still say NEW in words.
// Diamond ≠ square keeps the mark readable without color.
const MARK_NEW = `<svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.2" y="2.2" width="5.6" height="5.6" transform="rotate(45 5 5)" fill="currentColor"/></svg>`;

// The standalone STATUS column was removed (user direction 2026-09-18): it spent the row's
// lead position mostly on em-dashes and duplicated what the inverted set key already shows.
// The set keys are now the one status surface; NEW's diamond leads the title instead.
// Keep in sync with client-side TTL_NEW in js().
const titleNew = (isNew: boolean, status: string | null): string =>
  isNew && !status ? `<span class="ttl-new">${MARK_NEW}<span class="vh">new</span></span>` : "";

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

// Deadline urgency is weight, not hue: a live deadline inside 14 days sets bold white; a
// passed deadline drops to tertiary ink. The monochrome law leaves red no job on this page.
function seenCell(v: SearchResult["cards"][number]["variants"][number]): string {
  const delta = v.applicationDeadline ? v.applicationDeadline.getTime() - Date.now() : null;
  const soon = delta !== null && delta > 0 && delta < 14 * 86400_000;
  const passed = delta !== null && delta <= 0;
  return v.applicationDeadline
    ? `<span class="deadline${soon ? " soon" : ""}${passed ? " past" : ""}" title="application deadline">${passed ? "CLOSED" : "DUE"} ${fmtDate(v.applicationDeadline)}</span>`
    : fmtDate(v.firstSeenAt);
}

function citCell(v: SearchResult["cards"][number]["variants"][number]): string {
  return `${v.citizenshipStatus && v.citizenshipStatus !== "unknown" ? `<span class="cit">${CITIZEN_LABEL[v.citizenshipStatus] ?? ""}</span>` : ""}${degreeBadge(v.degreeStatus)}`;
}

// One CARD per role (Decision 28): the lead row is the newest posting of the role; each
// further geographic variant renders as its own slim `pos var` row directly beneath —
// same 8 cells, so columns stay ruled and the client JS (j/k, status keys, enter-to-open)
// works on variants for free, since every variant row carries its own real listing id.
function card(c: SearchResult["cards"][number]): string {
  const [rep, ...rest] = c.variants;
  const multi = rest.length > 0;
  const allLocs = c.variants.map((v) => v.location ?? "?").join(" · ");
  const meta: string[] = [];
  if (c.band) meta.push(`<span class="fit-band ${c.band}">${FIT_BAND_LABEL[c.band]}</span>`);
  if (c.csField) meta.push(`<span class="code">${FIELD_LABEL[c.csField] ?? esc(c.csField)}</span>`);
  const grad = gradWindow(rep.gradYearMin, rep.gradYearMax);
  const locCell = multi
    ? `<span class="nloc">${c.variants.length} LOCATIONS</span>`
    : esc((rep.location ?? "").length > 26 ? (rep.location ?? "").slice(0, 25) + "…" : (rep.location ?? ""));
  const parts = [
    // data-new is the ROW's own freshness (rep.isNew, not the card-level c.isNew): the client
    // uses it to restore the title diamond on status-clear, and it must agree with titleNew().
    `<tr class="pos${rep.status === "rejected" ? " rej-row" : ""}" data-id="${rep.id}"${rep.isNew ? " data-new" : ""} tabindex="0">
<td class="c-co"><span class="co" title="${esc(c.company)}">${esc(c.company)}</span></td>
<td class="c-title"><a href="${esc(rep.url)}" target="_blank" rel="noopener" title="${esc(c.title.trim())} — opens at ${esc(c.company)}">${titleNew(rep.isNew, rep.status)}${esc(c.title.trim())}</a>
  <span class="m-meta">${meta.join("")}${rep.location ? `<span class="loc">${esc(rep.location)}</span>` : ""}${grad ? `<span class="loc">${grad}</span>` : ""}${rep.citizenshipStatus && rep.citizenshipStatus !== "unknown" ? `<span class="loc">${CITIZEN_LABEL[rep.citizenshipStatus] ?? ""}</span>` : ""}${degreeBadge(rep.degreeStatus)}</span></td>
<td class="c-field">${c.csField ? `<span class="code">${FIELD_LABEL[c.csField] ?? esc(c.csField)}</span>` : ""}</td>
<td class="c-loc" title="${esc(multi ? allLocs : (rep.location ?? ""))}">${locCell}</td>
<td class="c-grad">${grad}</td>
<td class="c-cit">${citCell(rep)}</td>
<td class="c-seen">${seenCell(rep)}</td>
<td class="c-set">${setControl(rep.id, rep.status)}</td>
</tr>`,
  ];
  for (const v of rest) {
    const loc = v.location ?? "location unstated";
    const vGrad = gradWindow(v.gradYearMin, v.gradYearMax);
    parts.push(`<tr class="pos var${v.status === "rejected" ? " rej-row" : ""}" data-id="${v.id}"${v.isNew ? " data-new" : ""} tabindex="0">
<td class="c-co"></td>
<td class="c-title"><a href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(c.title.trim())} — ${esc(loc)}">${titleNew(v.isNew, v.status)}<span class="var-arm" aria-hidden="true">↳</span> ${esc(loc)}</a>
  <span class="m-meta">${vGrad ? `<span class="loc">${vGrad}</span>` : ""}${v.citizenshipStatus && v.citizenshipStatus !== "unknown" ? `<span class="loc">${CITIZEN_LABEL[v.citizenshipStatus] ?? ""}</span>` : ""}${degreeBadge(v.degreeStatus)}</span></td>
<td class="c-field"></td>
<td class="c-loc" title="${esc(v.location ?? "")}">${esc((v.location ?? "").length > 26 ? (v.location ?? "").slice(0, 25) + "…" : (v.location ?? ""))}</td>
<td class="c-grad">${vGrad}</td>
<td class="c-cit">${citCell(v)}</td>
<td class="c-seen">${seenCell(v)}</td>
<td class="c-set">${setControl(v.id, v.status)}</td>
</tr>`);
  }
  return parts.join("\n");
}

// --- screener fragments -------------------------------------------------------------------

// Filter chips: pill-shaped label + count. Selection is still a monochrome inversion — an
// active chip fills white with dark text and sets heavier; no hue is spent on selection.
function frow(href: string, label: string, count: number | undefined, on: boolean): string {
  return `<a class="chip${on ? " on" : ""}" href="${href}" aria-current="${on ? "true" : "false"}">
<span class="ch-label">${label}</span><span class="ch-count">${count ?? 0}</span></a>`;
}

const CHEV = `<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// State/country facets are rendered from live SQL group-by results, unlike TYPE/FIELD/
// STATUS (fixed label vocabularies), so a selected value can drop out of the facet map
// entirely once another filter narrows it to zero matches — the chip would then vanish
// with no way to deselect it short of "CLEAR FILTERS". Pin selected values into the list
// (count 0 if absent) and sort them first so the visible-slice cutoff never hides them.
function withSelected(entries: Array<[string, number]>, selected: string[] | undefined): Array<[string, number]> {
  if (!selected?.length) return entries;
  const have = new Map(entries);
  const selectedFirst: Array<[string, number]> = selected.map((v) => [v, have.get(v) ?? 0]);
  const rest = entries.filter(([v]) => !selected.includes(v));
  return [...selectedFirst, ...rest];
}

function railGroup(title: string, body: string, open = true): string {
  return `<details class="grp"${open ? " open" : ""}><summary>${CHEV}${title}</summary>${body}</details>`;
}

// --- page ---------------------------------------------------------------------------------

export function renderPage(
  p: SearchParams,
  res: SearchResult,
  profileState: "draft" | "approved" | "stale" | "none",
): string {
  // "stale" can't rank either — the FIT control must NOT appear for it (runSearch would
  // just downgrade); what differs from "none" is the remediation note below.
  const hasProfile = profileState === "draft" || profileState === "approved";
  const totalSheets = Math.max(1, Math.ceil(res.total / res.per));
  const anyFilter =
    !!(p.q || p.type || p.field || p.country || p.state || p.gradYear || p.status ||
       p.workplace || p.selective || p.newOnly);

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
  const stateEntries = withSelected(Object.entries(res.facets.state), p.state);
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
  const countryEntries = withSelected(Object.entries(res.facets.country), p.country);
  const countryRows = countryEntries
    .slice(0, 8)
    .map(([val, count]) =>
      frow(qs(p, { country: toggled(p.country, val) }), COUNTRY_LABEL[val] ?? val, count, p.country?.includes(val) ?? false),
    )
    .join("");
  const statusRows = Object.entries(STATUS_LABEL)
    .map(([val, label]) =>
      frow(qs(p, { status: toggled(p.status, val) }), label, res.facets.status[val], p.status?.includes(val) ?? false),
    )
    .join("");
  const workplaceRows = Object.entries(WORKPLACE_LABEL)
    .map(([val, label]) =>
      frow(qs(p, { workplace: toggled(p.workplace, val) }), label, res.facets.workplace[val], p.workplace?.includes(val) ?? false),
    )
    .join("");
  const years = [2026, 2027, 2028, 2029];
  const yearRows = years
    .map((y) => {
      const on = p.gradYear === y;
      return `<a class="chip${on ? " on" : ""}" href="${qs(p, { gradYear: on ? null : String(y) })}" aria-current="${on ? "true" : "false"}"><span class="ch-label">CLASS OF ’${String(y).slice(2)}</span></a>`;
    })
    .join("");
  const sorts: Array<[SearchParams["sort"], string]> = [
    ...(hasProfile ? ([["fit", "FIT"]] as Array<[SearchParams["sort"], string]>) : []),
    ["first_seen", "FIRST SEEN"], ["published", "PUBLISHED"], ["company", "COMPANY"], ["deadline", "DEADLINE"],
  ];
  // Curated-list toggle (Decision 32's annotation list, promoted to a filter): label-only
  // chip like the class-year row, deliberately with no count — a live count here would
  // imply the list is an assessment of the whole corpus rather than 26 hand-picked names.
  const selectiveOn = !!p.selective;
  const selectiveRow = `<a class="chip${selectiveOn ? " on" : ""}" href="${qs(p, { selective: selectiveOn ? null : "1" })}" aria-current="${selectiveOn ? "true" : "false"}"><span class="ch-label">CURATED LIST</span></a>`;
  const sortRows = sorts
    .map(([val, label]) => {
      const on = p.sort === val;
      return `<a class="chip${on ? " on" : ""}" href="${qs(p, { sort: val as string })}" aria-current="${on ? "true" : "false"}"><span class="ch-label">${label}</span></a>`;
    })
    .join("");

  // Board cards with NEW / EARLIER dividers (only meaningful on the freshness sort).
  // A card is NEW when any variant is — same predicate the card sort orders by, so the
  // divider still falls at a clean boundary.
  let rowsHtml = "";
  if (res.cards.length === 0) {
    rowsHtml = `<tr class="empty-row"><td colspan="8">
<div class="empty"><p class="empty-head">NO MATCHES</p>
<p class="empty-sub">Nothing on the board matches these filters.</p>
${anyFilter ? `<a class="clear-btn" href="/">CLEAR FILTERS</a>` : ""}</div></td></tr>`;
  } else {
    const showDividers = p.sort === "first_seen" && !p.newOnly;
    let inNew = false;
    let openedEarlier = false;
    const parts: string[] = [];
    for (let i = 0; i < res.cards.length; i++) {
      const c = res.cards[i];
      if (showDividers && i === 0 && c.isNew) {
        parts.push(`<tr class="divider new-div"><td colspan="8"><span>NEW</span><span class="div-detail">${res.newCount} IN ${NEW_WINDOW_DAYS} DAYS</span></td></tr>`);
        inNew = true;
      }
      if (showDividers && inNew && !c.isNew && !openedEarlier) {
        parts.push(`<tr class="divider"><td colspan="8"><span>EARLIER</span></td></tr>`);
        openedEarlier = true;
      }
      parts.push(card(c));
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
  <nav class="views" aria-label="views">
    <a href="/profile">PROFILE</a>
    <a href="/tryout">TRYOUT</a>
  </nav>
  <a class="new-block${p.newOnly ? " on" : ""}" href="${qs(p, { new: p.newOnly ? null : "1" })}" title="show only new listings" aria-current="${p.newOnly ? "true" : "false"}">
    <span class="nb-n">${res.newCount}</span>
    <span class="nb-l">NEW · ${NEW_WINDOW_DAYS}D</span>
  </a>
</header>
<div class="deck">
<aside class="screener" aria-label="filters">
  ${railGroup("RESUME", `<div class="resume-box">
    <textarea id="rs-ta" placeholder="PASTE RESUME TEXT — ranks the board by fit instantly, nothing saved until you say so" rows="4"></textarea>
    <div class="resume-actions">
      <button type="button" class="rs-btn primary" id="rs-submit">RANK BY THIS</button>
      ${profileState === "draft" ? `<button type="button" class="rs-btn" id="rs-save">SAVE AS MY PROFILE</button><button type="button" class="rs-btn" id="rs-clear">CLEAR</button>` : ""}
    </div>
    <textarea id="rt-exp" placeholder="OR DESCRIBE YOURSELF — your experience, a sentence or three" rows="2"></textarea>
    <textarea id="rt-seek" placeholder="WHAT YOU'RE SEEKING (optional)" rows="1"></textarea>
    <div class="resume-actions">
      <button type="button" class="rs-btn primary" id="rt-submit">RANK BY DESCRIPTION</button>
    </div>
    <p class="resume-note" id="rs-note">${esc(
      profileState === "draft"
        ? "Ranking by a draft (pasted or typed), not saved yet — hit SAVE to make it your profile."
        : profileState === "approved"
          ? "Ranking by your approved profile. Paste a resume to try a different one."
          : profileState === "stale"
            ? "Your profile's embedding is out of date (the embedding config changed since you approved it) — re-approve it on the PROFILE page to re-enable fit ranking."
            : "No profile yet — paste a resume to rank the board by fit.",
    )}</p>
  </div>`)}
  <form method="get" action="/" class="query">
    <input type="search" name="q" value="${esc(p.q ?? "")}" placeholder="SEARCH TITLE / COMPANY" aria-label="search title or company">
    ${p.type ? `<input type="hidden" name="type" value="${esc(p.type.join(","))}">` : ""}
    ${p.field ? `<input type="hidden" name="field" value="${esc(p.field.join(","))}">` : ""}
    ${p.state ? `<input type="hidden" name="state" value="${esc(p.state.join(","))}">` : ""}
    ${p.country ? `<input type="hidden" name="country" value="${esc(p.country.join(","))}">` : ""}
    ${p.status ? `<input type="hidden" name="status" value="${esc(p.status.join(","))}">` : ""}
    ${p.workplace ? `<input type="hidden" name="workplace" value="${esc(p.workplace.join(","))}">` : ""}
    ${p.selective ? `<input type="hidden" name="selective" value="1">` : ""}
    ${p.gradYear ? `<input type="hidden" name="gradYear" value="${p.gradYear}">` : ""}
    ${p.newOnly ? `<input type="hidden" name="new" value="1">` : ""}
    ${p.sort && p.sort !== "first_seen" ? `<input type="hidden" name="sort" value="${p.sort}">` : ""}
  </form>
  ${railGroup("TYPE", `<div class="chips">${typeRows}</div>`)}
  ${railGroup("FIELD", `<div class="chips">${fieldRows}</div>`)}
  ${railGroup("US STATE", `<div class="chips">${stateRows}</div>${stateMore ? `<details class="more"><summary>ALL STATES</summary><div class="chips">${stateMore}</div></details>` : ""}`)}
  ${railGroup("COUNTRY", `<div class="chips">${countryRows}</div>`, false)}
  ${railGroup("WORKPLACE", `<div class="chips">${workplaceRows}</div>`, false)}
  ${railGroup("EMPLOYER", `<div class="chips">${selectiveRow}</div><p class="grp-note">Hand-picked famous-for-selectivity employers (data/company-tiers.json) — unlisted companies are not assessed, not "less selective".</p>`, false)}
  ${railGroup("CLASS YEAR", `<div class="chips" role="group" aria-label="class year">${yearRows}</div><p class="grp-note">Listings stating no window stay visible.</p>`, false)}
  ${railGroup("MY PIPELINE", `<div class="chips">${statusRows}</div>`, false)}
  ${railGroup("ORDER", `<div class="chips" role="group" aria-label="sort">${sortRows}</div>`, false)}
  ${anyFilter ? `<a class="clear-btn rail-clear" href="/">CLEAR FILTERS</a>` : ""}
</aside>
<main class="board" id="board">
  <div class="board-head">
    <span class="bh-total"><b>${res.total}</b> ROLES</span>
    ${res.excludedUnenriched ? `<span class="bh-gap">${res.excludedUnenriched} MATCHING BUT NOT YET ENRICHED — EXCLUDED FROM FIT RANKING</span>` : ""}
    <span class="bh-sheet">PAGE ${res.page} / ${totalSheets}</span>
  </div>
  <table class="grid">
    <thead><tr>
      <th class="c-co" scope="col">COMPANY</th>
      <th class="c-title" scope="col">POSITION</th>
      <th class="c-field" scope="col">FIELD</th>
      <th class="c-loc" scope="col">LOCATION</th>
      <th class="c-grad" scope="col" title="stated graduation window">CLASS</th>
      <th class="c-cit" scope="col" title="citizenship / sponsorship">CIT</th>
      <th class="c-seen" scope="col" title="first seen (or deadline)">SEEN</th>
      <th class="c-set" scope="col" title="your application status — press a key to set, same key again to clear">STATUS</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <nav class="sheets" aria-label="pagination">
    ${res.page > 1 ? `<a class="sheet-btn" href="${pageHref(res.page - 1)}">PREV</a>` : `<span class="sheet-btn off">PREV</span>`}
    <span class="sheet-pos">PAGE ${res.page} / ${totalSheets}</span>
    ${res.page < totalSheets ? `<a class="sheet-btn" href="${pageHref(res.page + 1)}">NEXT</a>` : `<span class="sheet-btn off">NEXT</span>`}
  </nav>
  <p class="board-foot">j/k move · s save · a applied · i interview · o offer · x reject · u clear · enter open</p>
</main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>${js()}</script>
</body>
</html>`;
}

// --- styles -------------------------------------------------------------------------------

// Exported for the profile / tryout pages (render-profile.ts, render-tryout.ts): one
// stylesheet, one world — the new pages extend it with their own small blocks instead of
// forking the terminal look.
export function css(): string {
  return `
@font-face{font-family:'Chivo Mono';src:url('/fonts/chivo-mono.woff2') format('woff2');font-weight:100 900;font-display:swap}
:root{
  --bg0:#050507; --bg1:#0C0D11; --bg2:#13151B; --bg3:#1A1D25;
  --line:#1E2129; --line-2:#2A2E38;
  --ink:#ECEDEF; --ink-2:#9DA2AD; --ink-3:#7E8490;
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

/* ---- tape (header): one open row, one hairline below — no internal cell borders ---- */
.tape{display:flex;align-items:center;gap:26px;padding:0 22px;background:var(--bg1);border-bottom:1px solid var(--line-2)}
.brand{padding:10px 0}
.brand h1{font-family:var(--mono);font-size:13px;font-weight:700;letter-spacing:.18em;white-space:nowrap}
.brand-sub{display:block;font-family:var(--mono);font-size:9px;font-weight:500;letter-spacing:.22em;color:var(--ink-3);margin-top:2px}
.ticker{display:flex;flex:1;min-width:0;overflow-x:auto;font-family:var(--mono);gap:20px;scrollbar-width:none}
.ticker::-webkit-scrollbar{display:none}
.tick{display:flex;align-items:baseline;gap:7px;padding:6px 0;white-space:nowrap}
.tick:hover .tk-l{color:var(--ink)}
.tk-l{font-size:9px;font-weight:500;letter-spacing:.14em;color:var(--ink-3)}
.tk-n{font-size:13px;font-weight:500;color:var(--ink-2);font-variant-numeric:tabular-nums}
.tick.on{box-shadow:0 -2px 0 var(--ink) inset}
.tick.on .tk-l{color:var(--ink);font-weight:700}
.tick.on .tk-n{color:var(--ink);font-weight:700}
/* The one shouting figure: the NEW count is the page's single oversized element and never
   shrinks. Blue's only job on this page. */
.views{display:flex;gap:14px;font-family:var(--mono)}
.views a{font-size:10px;font-weight:600;letter-spacing:.16em;color:var(--ink-2);text-decoration:none;padding:4px 0;border-bottom:1px solid transparent}
.views a:hover{color:var(--ink);border-bottom-color:var(--line-2)}
.views a[aria-current="page"]{color:var(--ink);border-bottom-color:var(--ink)}
.new-block{display:flex;align-items:baseline;gap:10px;font-family:var(--mono)}
.new-block:hover .nb-l{color:var(--ink)}
.nb-n{font-size:40px;font-weight:600;line-height:56px;color:var(--blue);font-variant-numeric:tabular-nums}
.nb-l{font-size:9px;font-weight:600;letter-spacing:.18em;color:var(--ink-3)}
.new-block.on{box-shadow:0 -2px 0 var(--blue) inset}
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
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding:0 2px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border:1px solid var(--line-2);
  border-radius:999px;font-family:var(--mono);font-size:10.5px;font-weight:500;
  letter-spacing:.04em;color:var(--ink-2)}
.chip:hover{border-color:var(--ink-2);color:var(--ink)}
.chip.on{background:var(--ink);border-color:var(--ink);color:var(--bg0);font-weight:700}
.ch-label{white-space:nowrap}
.ch-count{font-size:9.5px;font-weight:500;color:var(--ink-3);font-variant-numeric:tabular-nums}
.chip.on .ch-count{color:var(--bg0);opacity:.65}
.more{margin-top:4px}
.more summary{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;color:var(--ink-3);cursor:pointer;padding:4px 6px;list-style:none}
.more summary::-webkit-details-marker{display:none}
.grp-note{font-size:11px;color:var(--ink-3);padding:6px 6px 0;line-height:1.4}
.rail-clear{margin-top:18px}
.clear-btn{display:inline-block;padding:8px 14px;border:1px solid var(--line-2);
  font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.16em;color:var(--ink-2)}
.clear-btn:hover{border-color:var(--ink);color:var(--ink)}

.resume-box{display:flex;flex-direction:column;gap:6px}
.resume-box textarea{background:var(--bg1);border:1px solid var(--line);color:var(--ink);
  font-family:var(--sans);font-size:12px;padding:8px;resize:vertical;min-height:70px}
.resume-box textarea::placeholder{color:var(--ink-3)}
.resume-actions{display:flex;gap:6px;flex-wrap:wrap}
.rs-btn{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.12em;
  padding:7px 10px;border:1px solid var(--line-2);color:var(--ink-2);background:var(--bg1);cursor:pointer}
.rs-btn:hover{border-color:var(--ink);color:var(--ink)}
.rs-btn.primary{background:var(--ink);color:var(--bg0);border-color:var(--ink)}
.rs-btn:disabled{opacity:.5;cursor:default}
.resume-note{font-size:11px;color:var(--ink-3);line-height:1.4;margin:0}
.fit-band{font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.1em;
  padding:1px 5px;border:1px solid var(--line-2);color:var(--ink-2)}
.fit-band.strong{background:var(--ink);color:var(--bg0);border-color:var(--ink)}
.fit-band.good{color:var(--ink);border-color:var(--ink-2)}

/* ---- board ---- */
.board{min-width:0;padding:0 0 40px}
.board-head{display:flex;align-items:baseline;justify-content:space-between;padding:13px 22px 10px}
.bh-gap{font-family:var(--mono);font-size:9.5px;color:var(--ink-3);letter-spacing:.06em}
.bh-total{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.18em;color:var(--ink-2)}
.bh-total b{font-size:14px;color:var(--ink);font-weight:600;letter-spacing:0}
.bh-sheet{font-family:var(--mono);font-size:10px;color:var(--ink-3);letter-spacing:.08em}
table.grid{width:100%;border-collapse:collapse}
.grid th{position:sticky;top:0;z-index:2;background:var(--bg1);text-align:left;
  font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.14em;color:var(--ink-3);
  padding:7px 8px;border-bottom:1px solid var(--line-2)}
.grid td{padding:0 8px;border-bottom:1px solid var(--line);height:40px;vertical-align:middle}
/* Fixed columns kept lean so POSITION (the flex column) gets the width — it is what the
   owner actually reads; company is recognizable truncated, a title is not. Company leads
   the row now (status column removed 2026-09-18) and carries the 22px board gutter. */
.grid th.c-co,.grid td.c-co{padding-left:22px}
.c-co{width:132px}
.c-field{width:60px}
.c-loc{width:150px}
.c-grad{width:62px}
.c-cit{width:68px}
.c-seen{width:80px}
.c-set{width:140px}
tr.pos:hover,tr.pos.cur{background:var(--bg2)}
/* Keyboard cursor: a 2px white inset bar at the left edge + row wash — monochrome, no hue */
tr.pos.cur{box-shadow:2px 0 0 var(--ink) inset}
tr.pos:focus-visible{outline:none;background:var(--bg2);box-shadow:2px 0 0 var(--ink) inset}
tr.rej-row td{opacity:.4}
tr.rej-row .c-title a{text-decoration:line-through;text-decoration-color:var(--ink-3)}
/* Variant rows (Decision 28): further locations of the role above. Slimmer, word-voice
   location as the link, no repeated company/title — the lead row already said them. */
tr.pos.var td{height:32px;border-bottom-style:dashed}
tr.pos.var .c-title a{font-size:12px;font-weight:400;color:var(--ink-2)}
tr.pos.var .var-arm{color:var(--ink-3);margin:0 4px 0 10px}
.nloc{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--ink)}
/* Company is a word, so it speaks the word voice (sans, normal case) — Two Voices rule */
.co{font-size:12px;font-weight:500;color:var(--ink-2);
  display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
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

/* ---- NEW mark: the blue diamond leads the position title on untouched fresh rows.
   Blue's one job, kept per-row so NEW survives every sort order. ---- */
.ttl-new{color:var(--blue);margin-right:7px}
.ttl-new .mk{width:9px;height:9px;vertical-align:-0.5px}

/* ---- set keys (status control) ---- */
.keys{display:inline-flex;gap:3px;opacity:.35}
tr.pos:hover .keys,tr.pos.cur .keys,tr.pos:focus-within .keys,.keys:has(.on){opacity:1}
.key{font-family:var(--mono);font-size:10px;font-weight:600;width:22px;height:22px;
  background:var(--bg0);color:var(--ink-2);border:1px solid var(--line-2);cursor:pointer}
.key:hover{border-color:var(--ink-2);color:var(--ink)}
.key.on{background:var(--ink);color:var(--bg0);border-color:var(--ink);font-weight:700}
.key.pending{opacity:.6}
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
.toast.show{visibility:visible}
@keyframes blink{0%{opacity:0}100%{opacity:1}}

/* ---- feed-connect (the one authored motion: rows snap in like a feed catching up).
   Nothing glides — steps(1) means each row appears whole, staggered down the board.
   The pending flash and toast blink also live here: any repeating flash is exactly what
   prefers-reduced-motion exists for; outside it, pending is a static dim. ---- */
@media (prefers-reduced-motion:no-preference){
  tbody tr{animation:snapin .01s steps(1,end) backwards;animation-delay:420ms}
  ${Array.from({ length: 52 }, (_, i) => `tbody tr:nth-child(${i + 1}){animation-delay:${i * 8}ms}`).join("")}
  tr.pos.ticked{animation:tick .24s steps(2,end)}
  .key.pending{opacity:1;animation:pend .5s steps(2,end) infinite}
  .toast.show{animation:blink .18s steps(2,end)}
}
@keyframes snapin{from{opacity:0}to{opacity:1}}
@keyframes tick{0%{background:var(--bg3)}100%{background:transparent}}

/* ---- mobile ---- */
@media (max-width:880px){
  .tape{flex-wrap:wrap;padding:0 14px;gap:0 14px}
  /* The figure never shrinks (locked raise) — the brand block yields instead. The views
     links leave row one entirely: with a 4-digit NEW count, brand + views + figure
     overflow 390px and clip the figure. */
  .brand{min-width:0;flex:1;padding:10px 0}
  .brand h1{font-size:11px;overflow:hidden;text-overflow:ellipsis}
  .new-block{order:2;flex:none}
  .views{order:3;flex-basis:100%;border-top:1px solid var(--line);padding:7px 0}
  .ticker{order:4;flex-basis:100%;border-top:1px solid var(--line);gap:16px}
  .deck{grid-template-columns:1fr}
  .screener{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line-2);padding:12px 14px 16px}
  .query input{font-size:16px}
  .grp{margin-top:8px;padding-top:6px}
  .grid thead{display:none}
  table.grid,tbody,tr.pos{display:block}
  tr.pos{position:relative;padding:10px 14px 10px 14px;border-bottom:1px solid var(--line)}
  tr.pos td{display:none;border:0;height:auto;padding:0}
  tr.pos td.c-co,tr.pos td.c-title,tr.pos td.c-set{display:block;width:auto;padding-left:0}
  .c-title{max-width:none}
  .c-title a{white-space:normal;font-size:14px;line-height:1.35}
  .co{max-width:none}
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

  // NEW title-diamond markup mirrors render-side titleNew(): keep the two in sync.
  var TTL_NEW='<span class="ttl-new"><svg class="mk" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.2" y="2.2" width="5.6" height="5.6" transform="rotate(45 5 5)" fill="currentColor"/></svg><span class="vh">new</span></span>';
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
        // NEW = untouched fresh row: setting a status retires the diamond, clearing on a
        // still-new row brings it back (same rule titleNew() applies server-side).
        var link=tr.querySelector('.c-title a');
        var mark=link&&link.querySelector('.ttl-new');
        if(next&&mark)mark.remove();
        else if(!next&&!mark&&tr.hasAttribute('data-new')&&link)link.insertAdjacentHTML('afterbegin',TTL_NEW);
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

  // Resume paste-and-go (Decision 34). Full reload on success — a fresh SSR render is the
  // simplest way to reflect a new ranking mode/profileState without duplicating renderPage's
  // logic client-side.
  var rsSubmit=document.getElementById('rs-submit');
  var rsSave=document.getElementById('rs-save');
  var rsClear=document.getElementById('rs-clear');
  var rsTa=document.getElementById('rs-ta');
  var rsNote=document.getElementById('rs-note');
  function rsBusy(b){[rsSubmit,rsSave,rsClear].forEach(function(el){if(el)el.disabled=b})}
  function rsError(msg){if(rsNote)rsNote.textContent=msg;rsBusy(false)}
  if(rsSubmit)rsSubmit.addEventListener('click',function(){
    var text=(rsTa.value||'').trim();
    if(text.length<40){rsError('PASTE MORE RESUME TEXT (40+ CHARS) — nothing sent.');return}
    rsBusy(true);if(rsNote)rsNote.textContent='EXTRACTING + EMBEDDING…';
    fetch('/api/search/paste',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({resumeText:text})})
      .then(function(r){if(r.ok)return r.json();return r.json().then(function(b){throw new Error(b.error==='ollama_down'?"OLLAMA IS DOWN — start 'ollama serve' and retry.":(b.reason||b.error||('HTTP '+r.status)))})})
      .then(function(){window.location.reload()})
      .catch(function(err){rsError(String(err.message||err))});
  });
  // Typed mode: same reload-on-success contract as paste; embed-only server side (no 14B),
  // so the busy note skips "EXTRACTING".
  var rtSubmit=document.getElementById('rt-submit');
  var rtExp=document.getElementById('rt-exp');
  var rtSeek=document.getElementById('rt-seek');
  if(rtSubmit)rtSubmit.addEventListener('click',function(){
    var exp=(rtExp.value||'').trim();
    if(exp.length<10){rsError('DESCRIBE YOUR EXPERIENCE (10+ CHARS) — nothing sent.');return}
    rsBusy(true);rtSubmit.disabled=true;if(rsNote)rsNote.textContent='EMBEDDING…';
    fetch('/api/search/typed',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({experience:exp,seeking:(rtSeek.value||'').trim()})})
      .then(function(r){if(r.ok)return r.json();return r.json().then(function(b){throw new Error(b.error==='ollama_down'?"OLLAMA IS DOWN — start 'ollama serve' and retry.":(b.error||('HTTP '+r.status)))})})
      .then(function(){window.location.reload()})
      .catch(function(err){rtSubmit.disabled=false;rsError(String(err.message||err))});
  });
  if(rsSave)rsSave.addEventListener('click',function(){
    rsBusy(true);
    fetch('/api/search/paste/save',{method:'POST'})
      .then(function(r){if(r.ok)return r.json();return r.json().then(function(b){throw new Error(b.error||('HTTP '+r.status))})})
      .then(function(){window.location.reload()})
      .catch(function(err){rsError('SAVE FAILED — '+String(err.message||err))});
  });
  if(rsClear)rsClear.addEventListener('click',function(){
    rsBusy(true);
    fetch('/api/search/paste/clear',{method:'POST'})
      .then(function(){window.location.reload()})
      .catch(function(){rsError('CLEAR FAILED — check the server and retry.')});
  });
})();`;
}
