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
default sort, amber blocks), then hunt within a filtered slice (rail levers). Both states are
one page; the rail is what converts queue → hunt.

Action/task: open a listing (row title, new tab) and dispatch it — throw an apply status
(saved/applied/interviewing/offer/rejected) by button or key (j/k + s/a/i/o/x/u/Enter).

Chosen direction: **The Dispatch Board** (CTC railroad panel; seed 2c04db5d, locked on the
decision page 2026-08-27). Raises carried: one light source; status marks as figure-ground
inversions; filter throws repack the board in one staggered motion; one hue one rule
(amber=awaiting decision, white=held, green=in-flight, red=live deadline pressure only;
rejected rows go dark). Memorable moment: throwing a lever — the nub slides and lights, and
the whole line repacks.

Constraints: facet counts computed with the facet's own selection removed; class-year filter
keeps unknown-window listings visible (86% of corpus states none); comp columns omitted
(0% coverage). No client framework — vanilla fetch + DOM per Decision 20.

Unresolved: note-editing UI (API supports notes); "remote-anywhere" as a first-class location
filter value (Decision 19 deferred it); light-theme variant (dark is scene-justified).
