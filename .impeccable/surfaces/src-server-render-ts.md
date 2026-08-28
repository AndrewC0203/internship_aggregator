---
version: 1
slug: "src-server-render-ts"
primary_target: "src/server/render.ts"
related_targets: []
---

# Surface brief: search page (/)

Scope: the hub's single operating surface — SSR search page at `/`, rendered by
`src/server/render.ts` from the `search()` query layer. Visitor mode: **Operate**.

Audience & job: the hub's owner on a daily pass — first triage the NEW queue (freshness-first
default sort, blue NEW band and figure), then hunt within a filtered slice (screener rail).
Both states are one page; the rail is what converts queue → hunt.

Action/task: open a listing (row title, new tab) and mark it — set an apply status
(saved/applied/interviewing/offer/rejected) by keycap button or key (j/k + s/a/i/o/x/u/Enter).

Chosen direction: **Terminal Board — Monochrome** (market-data terminal / watchlist grammar;
seed ff70fa62, locked on the decision page 2026-08-28, replacing the Dispatch Board world).
The user's pins: ultra-modern sleek, no vintage material, not a Linear clone, no market
green/red semantics. Raises carried: the NEW count is the page's single oversized element and
never shrinks; status is a mark + code word (HELD/APP/INT/OFF/REJ), readable without color;
nothing glides — every state change snaps and settles (steps() only); one law per hue —
#4D9FFF blue may only ever mean NEW, deadlines are bold white, rejected rows dim and strike;
a fixed numbered index column makes j/k keyboard position visible. Memorable moment: the huge
blue NEW figure over a monochrome ruled black board, and the tick — a committed status write
flashes and settles like a price update.

Constraints: facet counts computed with the facet's own selection removed; class-year filter
keeps unknown-window listings visible (86% of corpus states none); comp columns omitted
(0% coverage). No client framework — vanilla fetch + DOM per Decision 20. The market metaphor
stays structural, never literal: no sparklines, tickers of fake prices, or gain/loss color —
the corpus has no per-listing time series to plot.

Unresolved: note-editing UI (API supports notes); "remote-anywhere" as a first-class location
filter value (Decision 19 deferred it); column-header sorting (ORDER lives in a collapsed rail
group) and a data-age stamp on the tape — both named by the finish reviewer as unused ceiling,
neither blocking.
