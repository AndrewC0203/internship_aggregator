---
name: Terminal Board
description: A market-terminal rendering of the CS opportunities hub — near-monochrome ruled data surfaces where blue only ever means NEW
colors:
  bg0: "#050507"
  bg1: "#0C0D11"
  bg2: "#13151B"
  bg3: "#1A1D25"
  line: "#1E2129"
  line-2: "#2A2E38"
  ink: "#ECEDEF"
  ink-2: "#9DA2AD"
  ink-3: "#7E8490"
  blue: "#4D9FFF"
typography:
  display:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: "64px"
    fontFeature: "tabular-nums"
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    lineHeight: 1.45
  label:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.14em"
  figures:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    fontFeature: "tabular-nums"
  micro-label:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "9px"
    fontWeight: 600
    letterSpacing: "0.14em"
  secondary:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 500
  ticker-figure:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "15px"
    fontWeight: 500
    fontFeature: "tabular-nums"
  input-mobile:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "16px"
  empty-display:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "0.24em"
rounded:
  none: "0"
  focus: "1px"
  pill: "999px"
spacing:
  cell: "8px"
  rail: "14px"
  gutter: "22px"
components:
  row:
    height: "40px"
  key:
    backgroundColor: "{colors.bg0}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    size: "22px"
  key-on:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg0}"
  filter-chip:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "4px 11px"
  filter-chip-on:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg0}"
  search-input:
    backgroundColor: "{colors.bg0}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "9px 11px"
  code-chip:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    padding: "2px 5px"
  clear-button:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  toast:
    backgroundColor: "{colors.bg3}"
    textColor: "{colors.ink}"
    padding: "10px 18px"
---

# Design System: Terminal Board

## Overview

**Creative North Star: "The Terminal Board"**

The hub is a job search run as a market terminal. Listings are instruments on a watchlist,
the pipeline is the portfolio, and NEW is the movers column. The world refuses the
white-card job board entirely: no cards, no light surfaces, no imagery, no brand gradients.
The material is true-black ruled data surfaces — four background steps from `bg0` to `bg3`,
white-to-gray inks, hairline rules — and the market metaphor is structural (density, the
numbered index column, tick motion), never literal: no fake charts, no gain/loss color.

The page is near-total monochrome. Exactly one hue exists — blue — and it has exactly one
job: NEW. Application status is a 10px authored mark plus a code word (HELD / APP / INT /
OFF / REJ), never a hue. Selection and commitment are weight and monochrome inversion, not
tint. Nothing glides: every state change is a `steps()` animation that snaps and settles
like a price tick. Rows are 40px, labels are 9–10px tracked mono caps, every figure is
tabular Chivo Mono, and the whole board runs from the keyboard (j/k/enter/s/a/i/o/x/u).

Provenance: direction contract seed `ff70fa62` (market-data terminal, monochrome rendition,
candidate 3 of 7), locked on the decision page 2026-08-28, replacing the retired "Dispatch
Board" world (seed `2c04db5d`). It is carried as the first HTML comment in the emitted
`<body>` of `src/server/render.ts`. Finish review disposition: **ship** (fix round fully
resolved, 2026-08-28). All CSS and JS are inline in `render.ts` (`css()` / `js()`); the
only external request is the single self-hosted `chivo-mono.woff2`.

**Key Characteristics:**
- True-black ruled data surfaces: four background steps, two hairline rules, three inks, one blue
- One law per hue — blue means NEW and nothing else; no green, no red, anywhere
- Status is a mark + code word; selection is weight and monochrome inversion
- Flat and square: no shadows-as-depth, no radii (focus ring's 1px is the lone exception)
- Nothing glides — all motion is `steps()`, gated behind `prefers-reduced-motion`
- One oversized element: the 40px blue NEW figure, which never shrinks
- Browser chrome themed in-world: inverted selection, white caret, dark scrollbar, 2px white focus ring, tabular numerals

## Colors

A ten-value monochrome ramp plus a single signal hue; every value below is a CSS custom
property on `:root` and is the only place color enters the system.

### Primary
- **Blue** (`#4D9FFF`, `--blue`): the page's one chromatic law — it may only ever mean NEW.
  It renders the oversized NEW figure in the tape, the NEW status diamond on untouched fresh
  rows, the NEW divider band (its legend and 1px bottom rule), the 2px inset underline when
  the new-only filter is active, and the favicon square. It never appears as interaction
  chrome, decoration, or any second meaning.

### Neutral
- **Bg 0** (`#050507`, `--bg0`): the deepest ground — page background, key and search-input
  wells, scrollbar track, and the dark text on every inversion.
- **Bg 1** (`#0C0D11`, `--bg1`): panel ground — the tape, the screener rail, sticky column
  heads, divider bands.
- **Bg 2** (`#13151B`, `--bg2`): the hover/selected wash — row hover, keyboard-cursor rows,
  tick and filter-row hover, active ticker cells.
- **Bg 3** (`#1A1D25`, `--bg3`): highest ground — the toast body and the tick flash a
  committed write settles from.
- **Line** (`#1E2129`, `--line`): the hairline rule — row borders, rail group separators,
  ticker cell dividers, the intra-tape seams.
- **Line 2** (`#2A2E38`, `--line-2`): the structural border — tape bottom, rail right edge,
  column-head underline, and every control border (inputs, keys, chips, buttons); also the
  scrollbar thumb.
- **Ink** (`#ECEDEF`, `--ink`): primary ink — row titles, committed figures, in-flight
  status, active labels, inversion fills, the focus ring, selection ground, caret.
- **Ink 2** (`#9DA2AD`, `--ink-2`): secondary ink — company names, cell data, filter labels,
  held status, placeholders, button text.
- **Ink 3** (`#7E8490`, `--ink-3`): tertiary ink — column heads, counts, index numbers,
  idle/rejected status, footnotes, passed deadlines.

### Named Rules
**The One Law Per Hue Rule.** Blue = NEW. That is the whole chromatic vocabulary. There is
no green, no red, no amber anywhere on the board: urgency is weight (a live deadline inside
14 days sets bold white; a passed one drops to `ink-3` "CLOSED"), and rejection is loss of
light (rows at `opacity: .4` with a line-through title), never a hue. A second hue, or a
second job for blue, breaks the world.

**The Mark-Plus-Code Rule.** Application state is a 10px authored SVG mark plus a mono code
word: outline square = HELD, filled square = APP / INT / OFF (in flight), stroke cross =
REJ. State never gets a color; the marks differ by fill and the words differ by ink weight.
Render-side `statusCell()` and client-side `statusCellHTML()` are the same rule in two
runtimes and must never drift.

## Typography

**Display/Label/Figure Font:** Chivo Mono (self-hosted variable woff2, weights 100–900,
`font-display: swap`; fallback ui-monospace, monospace)
**Body Font:** system-ui stack (`system-ui, -apple-system, 'Segoe UI', sans-serif`)

**Character:** Chivo Mono is the terminal's voice — every figure, label, code, count, date,
key-cap, and the typed search query render in it, always with
`font-variant-numeric: tabular-nums` on numeric columns. The system sans carries only
running words: position titles, locations, notes, empty-state subtext, the toast. National
Park (the retired world's face) is gone; the board loads exactly one font file.

### Hierarchy
- **Display** (Chivo Mono 600, 40px / 56px line): the NEW count in the tape — the page's
  single oversized element. Nothing else on the board approaches this size, and it never
  shrinks at any breakpoint.
- **Title** (sans 500, 13.5px, `ink`): the position link in each row; 14px and wrapping on
  mobile cards.
- **Body** (sans 400, 14px / 1.45): the page default; almost everything renders smaller.
- **Label** (Chivo Mono 700, 9–10px, tracked 0.14–0.24em, UPPERCASE): column heads and
  ticker labels (.14em), buttons (.16em), the brand h1 and NEW label (.18em), rail
  summaries and dividers (.2em), the brand sub (.22em), the empty-state head (18px /
  .24em). The wider the tracking, the more architectural the label.
- **Figures** (Chivo Mono 500–600, 9–15px, `tabular-nums`): counts, dates,
  grad windows (`’26–’27` / `’28+` / `≤’27`), citizenship codes, code chips, key-caps,
  page positions, the keyboard legend, and the search input (11.5px).
- **Company** (sans 500, 12px, `ink-2`): company names are running words, so they speak
  the word voice in normal case — never mono, never caps (refined 2026-08-28).

### Named Rules
**The Two Voices Rule.** Chivo Mono renders every figure, code, and label; the system sans
speaks every running word. No third family, no remote font, and numeric data is always
tabular.

**The One Figure Rule.** The 40px NEW figure is the only oversized element the page may
carry. At the 880px breakpoint the brand block yields (shrinks and truncates) so the figure
never does. A second shouting number would repeal the law that makes the first one legible.

## Layout

Full-bleed terminal; no centered max-width container. Structure top-down:

- **Tape** (header): one open flex row on `bg1` with a single `line-2` bottom rule and no
  internal seams (de-clunked 2026-08-28) — brand block left, the per-type ticker center as
  inline label + count pairs (`flex: 1`, 20px gaps, horizontal scroll with the scrollbar
  hidden), and the NEW block right (the 40px figure + "NEW · 3D" label). Active ticker
  items and the active NEW block take a 2px inset underline (ink for types, blue for NEW)
  and 700 weight — no background wash.
- **Deck**: CSS grid `240px 1fr`, zero gap.
- **Screener rail** (left 240px): `position: sticky; top: 0; max-height: 100vh` with its
  own scroll, on `bg1` with a `line-2` right rule. Search input first, then native
  `<details>` groups separated by `line` top-borders — TYPE, FIELD, US STATE open by
  default; COUNTRY, CLASS YEAR, MY PIPELINE, ORDER closed — with "ALL STATES" nested as a
  quieter disclosure, and CLEAR FILTERS at the bottom when any filter is set.
- **Board** (main): board head (total + page position, 22px gutter), sticky mono column
  heads (`top: 0`, `bg1`, 9px / 700 / .14em), 40px rows with 8px cell padding and `line`
  bottom rules. Fixed column widths — status 66 (plus the 22px gutter lead) / company 118 /
  field 60 / location 150 / class 62 / cit 68 / seen 80 / set 140 — with the position
  column flexing; fixed columns stay lean so POSITION gets the width.
  NEW / EARLIER divider bands (28px, `bg1`, 22px gutter) appear only on the default
  first-seen sort without new-only; the NEW band carries the blue legend and blue bottom
  rule.
- **Sheets**: centered PREV / PAGE n / m / NEXT, 50 rows per page, then the mono keyboard
  legend (`j/k move · s save · … · enter open`).

There is no index column (removed by user direction 2026-08-28 — it spent width on a
number nobody read): keyboard position is carried by the cursor bar instead (see Rows).

**Responsive — the 880px snap.** One breakpoint, `max-width: 880px`: the tape wraps (brand
flexes and truncates, NEW block holds, ticker drops to its own full-width row); the deck
collapses to one column; the rail goes static with all groups collapsed (JS removes
`[open]` on load) and the search input bumps to 16px (prevents mobile zoom-on-focus); the
table re-flows to stacked cards — `thead` hidden, `table/tbody/tr` display block, each row
a `line`-ruled card showing company, wrapped title, the `.m-meta` strip (field chip,
location, class, citizenship), and the key row, with the status code absolutely placed
top-right. Keys are always awake on mobile (no hover); the keyboard footer is hidden.

**Motion — nothing glides.** Every animation is `steps()`; nothing eases, fades, or
slides. The one authored arrival moment is **feed-connect**: rows snap in whole
(`snapin .01s steps(1, end) backwards`), staggered 8ms per row via `nth-child` delays 1–52
after a 420ms base delay — a feed catching up, not a curtain rising. A committed status
write flashes **the tick** (`tick .24s steps(2, end)`, `bg3` → transparent); an in-flight
write flashes **pend** (`.5s steps(2, end) infinite`); the toast arrives with **blink**
(`.18s steps(2, end)`). All four live inside
`@media (prefers-reduced-motion: no-preference)`; outside it, pending is a static dim
(`opacity: .6`) and everything else simply appears.

**The Nothing Glides Rule.** New motion must be a `steps()` snap, gated behind
`prefers-reduced-motion`, with a static fallback. A `transition` or eased keyframe is a
foreign material here — there are none in the build, and none may be added.

## Elevation & Depth

Flat, fully. There are no drop shadows, no glows, no gradients, no blurs anywhere in the
system. Depth is conveyed by the four-step background ramp (`bg0` recessed wells → `bg1`
panels → `bg2` hover wash → `bg3` toast/flash) and by hairline rules: `line` between
repeating things, `line-2` between structural regions and around controls. The only
`box-shadow` forms in the build are the 2px inset underline bar on active tape items
(`0 -2px 0` in ink or blue) and the 2px inset cursor bar on the keyboard row
(`2px 0 0` in ink) — markers drawn with the shadow primitive, not depth.

### Named Rules
**The Ruled-Surface Rule.** New panels are separated by hairlines and background steps,
never by shadow. If a surface needs to read as "above," it takes the next background step
and a `line-2` rule; if an element needs to read as "active," it inverts or takes the 2px
inset underline.

## Shapes

Square. Border-radius does not exist in this world: chips, keys, inputs, buttons, the
toast, and every panel are hard-cornered. Exactly two exceptions are lawful, both browser
chrome: the `:focus-visible` ring carries `border-radius: 1px` (a bare softening so the
2px white outline doesn't fray at the corners — this is the value behind the
`design-system-radius` suppression in `.impeccable/config.json`, now lawful here), and the
scrollbar thumb is 5px-rounded with a 2px `bg0` inset border. Borders are always 1px, in
`line` (between repeats) or `line-2` (around controls). The only drawn geometry is the
authored 10px SVG set: the four status marks (outline square, filled square, cross, and
the blue NEW diamond) and the rail chevron — all `currentColor`, drawn not borrowed. One rounded control exists: the filter
chip's pill (user-directed amendment, 2026-08-28). Everything else stays square — no other
pills, no circles, no icon fonts, no imagery.

## Components

### Status Cell (signature)
The first column of every row: an authored mark plus its code word, in 10px / 600 / .08em
Chivo Mono. HELD (outline square, `ink-2`), APP / INT / OFF (filled square, `ink` — in
flight), REJ (cross, `ink-3`), NEW (blue diamond mark only, with visually-hidden "new"
text — the word was noise stamped fifty times a sheet; it survives in the divider and the
tape figure), or an idle `ink-3` em-dash. Rejected rows additionally drop to `opacity: .4` with a line-through
title. The markup is generated twice — `statusCell()` server-side, `statusCellHTML()`
client-side — and the comment in each points at the other; keep them in sync. On mobile
the cell detaches and pins to the card's top-right corner.

### Set Keys (status control)
- **Shape:** five square 22×22px key-caps, S / A / I / O / X, Chivo Mono 10px / 600.
- **Rest:** `bg0` well, `ink-2` cap, `line-2` border; the group idles at `opacity: .35`
  and wakes on row hover, keyboard cursor, focus-within, or when one is on. Always awake
  on mobile.
- **On:** hard monochrome inversion — `ink` ground, `bg0` cap, 700, `aria-pressed="true"`.
- **Pending:** the `pend` steps-flash while the PUT is in flight (static dim without
  motion); success fires the row tick; failure raises the toast ("WRITE FAILED — status
  not saved."). Pressing the active key again clears the status.

### Filter Chips (screener)
- **Style:** wrapping pill chips (`rounded.pill`, the world's one rounded control — a
  user-directed amendment, 2026-08-28) — mono label (10.5px / 500 / .04em) + 9.5px tabular
  count, `line-2` border, `ink-2` at rest; hover brightens border and label to `ink`.
- **On:** monochrome inversion — the chip fills `ink` with `bg0` text at 700;
  `aria-current="true"`. Selection still spends no hue.
- Filters are links that re-render the page (toggle semantics via querystring); any filter
  change resets to page 1. Sort and class-year chips are the same anatomy without counts.

### Search Input
`bg0` recessed well, `line-2` border, square, Chivo Mono 11.5px, `ink` text and caret,
`ink-2` placeholder ("SEARCH TITLE / COMPANY"). Focus takes the global ring
(`outline: 2px solid var(--ink); outline-offset: 2px`). Hidden inputs carry every other
active filter so a search never drops them. 16px on mobile.

### Buttons (clear / pagination)
Square, `line-2` border, transparent ground, tracked mono caps (10px / 700 / .16em),
`ink-2`. Hover raises border and text to `ink` — monochrome, never blue. Disabled page
buttons drop to `opacity: .3`.

### Code Chip
Field codes (SWE, ML/AI, QUANT…): Chivo Mono 9.5px / 600, `ink-2`, 1px `line-2` border,
square, `2px 5px` padding. Informational only — no selected state, no hue.

### Tape (navigation)
The identity header: brand block (13px / 700 / .18em h1 over a 9px / .22em `ink-3` sub),
the ticker (inline per-type label + count pairs that toggle type filters; active = 2px
ink inset underline + 700), and the NEW block (the 40px blue figure beside its label;
active new-only filter = 2px blue inset underline). One open row, no internal seams; the
tape closes with the single `line-2` rule.

### Rows (the board)
40px ruled rows; hover and the keyboard cursor take the `bg2` wash. The keyboard cursor is
a 2px `ink` inset bar at the row's left edge over that wash — monochrome, unmistakable;
row `:focus-visible` gets the same treatment (no outline). The
board is keyboard-first: j/k move the cursor, enter opens the position, s/a/i/o/x set
status, u clears; clicking a row (not a link or key) also seats the cursor. The SEEN cell
shows first-seen date, or the deadline when one exists: "DUE MM-DD" in bold `ink` inside
14 live days, "CLOSED MM-DD" in `ink-3` after.

### Toast
Bottom-center fixed: `bg3`, `line-2` border, square, sans 12px, `role="status"` +
`aria-live="polite"`. Appears with the `blink` steps-flash, auto-hides after 3.5s.
Currently used only for write failures.

### Empty State
Centered on the board: "NO MATCHES" (mono 18px / 700 / .24em, `ink-2`), one sans sentence,
and the CLEAR FILTERS button when filters are set.

**The Monochrome Inversion Rule.** A committed or focused state is a hard figure-ground
flip in black and white — active keys, active filter chips, the cursor bar, active ticker
underlines, `::selection`. Never a tint, never a hue (blue's underline on the NEW block is
NEW's identity, not a selection color).

## Do's and Don'ts

### Do:
- **Do** keep blue (`#4D9FFF`) on its one job: NEW, and nothing else — the figure, the
  status word, the divider band, the new-only underline, the favicon.
- **Do** express state as an authored 10px mark + mono code word, and urgency as weight
  (bold white live deadlines, `ink-3` passed ones).
- **Do** make committed and focused states hard monochrome inversions with truthful
  `aria-pressed` / `aria-current`.
- **Do** set every figure, label, and code in Chivo Mono — labels as tracked caps
  (0.14–0.24em), numerals always `tabular-nums` — and running words in the system sans.
- **Do** build new motion as `steps()` snaps inside
  `@media (prefers-reduced-motion: no-preference)` with a static fallback; flashing states
  especially stay behind the gate.
- **Do** separate new surfaces with `line`/`line-2` hairlines and the four background
  steps; keep every control square with a 1px border.
- **Do** theme browser chrome in-world on any new surface: inverted white selection, white
  caret, dark 10px scrollbar, the 2px white `:focus-visible` ring (1px radius).
- **Do** keep render-side `statusCell()` and client-side `statusCellHTML()` in lockstep
  when states change — same rule, two runtimes.

### Don't:
- **Don't** introduce a second hue or a second job for blue — no green/red gain-loss
  color, no red errors, no amber warnings; this world's market metaphor is structural,
  never literal (no fake charts, no sparklines).
- **Don't** add white cards, light surfaces, gradients, glows, drop shadows, or imagery —
  the only lawful `box-shadow` form is the 2px inset tab underline.
- **Don't** round a corner (filter-chip pill, focus ring's 1px, and the scrollbar thumb
  excepted), add a non-1px border, or bring in a second pill shape or a circle.
- **Don't** ease, fade, slide, or transition anything — nothing glides; and don't author a
  second arrival moment: feed-connect owns it.
- **Don't** oversize a second element — the 40px NEW figure is the page's single shout and
  never shrinks; competing scale dilutes it.
- **Don't** add a third typeface or a remote font; the board loads one woff2.
