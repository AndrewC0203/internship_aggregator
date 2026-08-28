---
name: Dispatch Board
description: Backlit-enamel CTC dispatch panel — the visual system of the CS opportunities hub
colors:
  amber: "#FFB000"
  amber-soft: "#FFC24D"
  green: "#46C978"
  white-lamp: "#F2F7F0"
  red: "#FF6B5E"
  enamel-0: "#0E1512"
  enamel-1: "#141D18"
  enamel-2: "#1B2721"
  enamel-3: "#24332B"
  etch: "#E9EFE9"
  etch-dim: "#A9BFB0"
  etch-faint: "#84998B"
  groove: "#0A100D"
  ridge: "#2C3D33"
typography:
  display:
    fontFamily: "National Park, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    letterSpacing: "0.14em"
  title:
    fontFamily: "National Park, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
  body:
    fontFamily: "National Park, system-ui, sans-serif"
    fontSize: "15px"
    lineHeight: 1.45
  label:
    fontFamily: "National Park, system-ui, sans-serif"
    fontSize: "9.5px"
    fontWeight: 700
    letterSpacing: "0.18em"
  figures:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 600
    fontFeature: "tabular-nums"
  secondary:
    fontFamily: "National Park, system-ui, sans-serif"
    fontSize: "12px"
  note:
    fontFamily: "National Park, system-ui, sans-serif"
    fontSize: "13px"
  stat:
    fontFamily: "Chivo Mono, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 600
    fontFeature: "tabular-nums"
  empty-display:
    fontFamily: "National Park, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "0.2em"
rounded:
  focus: "2px"
  chip: "3px"
  control: "4px"
  panel: "5px"
  lamp: "50%"
spacing:
  cell: "8px"
  rail: "14px"
  gutter: "22px"
components:
  throw:
    backgroundColor: "{colors.groove}"
    textColor: "{colors.etch-dim}"
    rounded: "{rounded.chip}"
    size: "24px"
  throw-on:
    backgroundColor: "{colors.etch}"
    textColor: "{colors.enamel-0}"
  lever:
    textColor: "{colors.etch-dim}"
    rounded: "{rounded.control}"
    padding: "5px 6px"
  lever-on:
    textColor: "{colors.etch}"
  scan-input:
    backgroundColor: "{colors.groove}"
    textColor: "{colors.etch}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
  clear-button:
    textColor: "{colors.etch-dim}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  code-chip:
    textColor: "{colors.etch-dim}"
    rounded: "{rounded.chip}"
    padding: "2px 5px"
  new-indicator:
    backgroundColor: "{colors.enamel-1}"
    rounded: "{rounded.panel}"
    padding: "7px 13px"
  new-indicator-on:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.enamel-1}"
---

# Design System: Dispatch Board

## Overview

**Creative North Star: "The Dispatch Board"**

The hub is a CTC railroad dispatcher's panel, not a job board. Every listing is a block on
the line; every apply-status is a lamp the dispatcher throws. The world refuses the
white-card job-board scaffold entirely: there are no cards, no light surfaces, no brand
gradients. The material is backlit enamel — deep green-black grounds machined into panels,
legends etched in near-white, indicator lamps that emit real light. One faint top-center
backlight (a radial wash on the deck) is the single ambient light source; every other glow
comes from a lit lamp.

Density is the point. Rows are 42px, labels are 9–11px tracked caps, figures are tabular
mono. The dispatcher reads the amber NEW band, throws levers to narrow the line, and
dispatches each block without leaving the keyboard. Committed states are hard figure-ground
inversions, never tints. Rejected blocks are not colored "error red" — they go dark, the way
a closed block loses its light.

Provenance: direction contract seed `2c04db5d` (candidate 5 of 7, "Dispatch/CTC control
board"), carried as the first HTML comment in the emitted `<body>` of
`src/server/render.ts`. Finish review disposition: **ship** (2026-08-27). All CSS and JS are
inline in `render.ts` (`css()` / `js()`); the only external requests are two self-hosted
woff2 files.

**Key Characteristics:**
- Backlit-enamel dark world: four enamel grounds, three etch inks, one groove + one ridge seam pair
- Lamp semantics carry all state color; each hue has exactly one meaning
- Two voices: National Park for every word, Chivo Mono for every figure
- Depth by machined seams and inset shadows, not drop shadows
- One authored motion moment (the repack); everything else is sub-250ms functional transition
- Browser chrome is themed in-world: selection, caret, scrollbar, focus ring, tabular numerals
- Microcopy stays in the dispatcher's voice ("BLOCKS ON THE LINE", "SIGNAL FAILURE")

## Colors

A near-monochrome green-black enamel field where color is scarce and strictly semantic:
four signal hues, each owning exactly one meaning.

### Primary
- **Amber** (`#FFB000`): the board's attention hue. As a lamp: a new block awaiting the
  dispatcher's decision. As interaction chrome: the focus ring, the input caret, text
  selection (amber ground, dark text), hover underline on row titles (via its soft step),
  and hover border on clear/sheet buttons. The NEW indicator inverts to solid amber when
  active. Also the favicon lamp.
- **Amber Soft** (`#FFC24D`): amber's lower-wattage step — NEW divider legend text and the
  title hover underline. Never a lamp fill.

### Secondary
- **Green** (`#46C978`): in-flight. The lamp for applied / interviewing / offer. Appears
  nowhere else.

### Tertiary
- **White Lamp** (`#F2F7F0`): held. The lamp for saved blocks, and the thrown position of a
  lever's slide pip. A brightness apart from the etch inks — it glows.
- **Red** (`#FF6B5E`): live deadline pressure only — a deadline inside 14 days that has not
  passed. A passed deadline is a closed window (`etch-faint`, "CLOSED"), not urgency. Red is
  never decoration and never a general error color.

### Neutral
- **Enamel 0** (`#0E1512`): the deepest ground — page background, scrollbar track.
- **Enamel 1** (`#141D18`): panel ground — the interlocking rail, plate gradient base,
  divider bands. Also the dark text sitting on amber inversions.
- **Enamel 2** (`#1B2721`): raised ground — plate gradient top, sticky column heads, row
  hover/selected wash.
- **Enamel 3** (`#24332B`): highest ground — hover fills, active plate-counts, toast body,
  scrollbar thumb.
- **Etch** (`#E9EFE9`): primary legend ink — titles, the h1, thrown-state fills.
- **Etch Dim** (`#A9BFB0`): secondary ink — company names, cell text, lever labels, column
  data.
- **Etch Faint** (`#84998B`): tertiary ink — column heads, counts, footnotes, legends,
  disabled/past states.
- **Groove** (`#0A100D`): the recessed seam — row/panel borders, input and throw-button
  grounds, the unlit lamp socket.
- **Ridge** (`#2C3D33`): the raised seam — 1px highlight borders and inset top-edges on
  panels, chips, and controls.

### Named Rules
**The One Lamp, One Meaning Rule.** Amber = awaiting your decision (new and untouched).
White = held (saved). Green = in flight (applied / interviewing / offer). Red = live
deadline pressure only. A rejected block gets no hue at all — it goes dark (`opacity: .45`,
extinguished lamp). No signal hue may take a second job.

**The Amber Chrome Rule.** Amber is additionally the only interaction accent — focus ring,
caret, selection, hover accents. Green, white-lamp, and red never appear in interaction
chrome; they exist only as state.

## Typography

**Display Font:** National Park (variable woff2, weights 200–800; fallback system-ui, sans-serif)
**Body Font:** National Park — the same routed-signage face is both the display and text voice
**Label/Mono Font:** Chivo Mono (variable woff2, weights 100–900; fallback ui-monospace, monospace)

**Character:** National Park reads as legends routed into enamel — geometric, sturdy,
all-purpose. Chivo Mono is the instrument readout: every number on the board is tabular.
Both are self-hosted under `src/server/public/fonts/` and served by the `/fonts/:file`
allowlist route with immutable caching; no third face, no remote fonts.

### Hierarchy
- **Display** (700, 19px, tracked 0.14em): the plate h1 ("DISPATCH BOARD") — the only
  display-size text on the board.
- **Title** (500, 14px, `etch`): the position link in each row; 14.5px and wrapping on
  mobile blocks.
- **Body** (400, 15px base / 1.45): the page default; almost everything renders smaller.
- **Label** (600–700, 9–11px, tracked 0.14–0.2em, UPPERCASE): column heads, rail group
  summaries, plate sub, divider legends, button text, company names (11px / 0.09em). The
  wider the tracking, the more architectural the label (dividers reach 0.18em).
- **Figures** (Chivo Mono 500–600, 9.5–16px, `tabular-nums`): counts, dates, grad-year
  windows, citizenship codes, code chips, throw key-caps, sheet positions, the keyboard
  legend, and the scan input's typed query.

### Named Rules
**The Two Voices Rule.** National Park speaks every word; Chivo Mono renders every figure,
code, date, count, and key-cap (plus the scan query). No text may use a third family, and
numeric columns are always `font-variant-numeric: tabular-nums`.

**The Tracked Caps Rule.** Every label is uppercase, 9–11px, letter-spaced 0.14–0.2em, in
an etch ink. Sentence-case is reserved for row titles, notes, and empty-state subtext.

## Layout

Full-bleed instrument panel; no centered max-width container. Structure top-down:

- **Legend plate** (header): flex row — identity block, scrolling type-count strip
  (`flex: 1`), NEW indicator right. Padding `14px 22px 13px`.
- **Deck**: CSS grid `262px 1fr`, zero gap. The radial backlight
  (`radial-gradient(140% 420px at 50% 0, rgba(233,239,233,.05), transparent 70%)`) sits on
  the deck — the world's one ambient light source.
- **Interlocking rail** (left 262px): `position: sticky; top: 0; max-height: 100vh` with its
  own scroll. Scan input, then `<details>` filter groups separated by groove top-borders
  (TYPE, FIELD, US STATE open by default; COUNTRY, CLASS YEAR, MY PIPELINE, ORDER closed),
  then the lamp legend.
- **The line** (main): sticky column heads (`top: 0`, enamel-2), 42px row height, 8px cell
  padding, fixed column widths (lamp 30 / company 170 / field 64 / location 190 / class 64 /
  cit 70 / seen 76 / dispatch 150; position flexes). 22px page gutter on head and dividers.
- **Sheets**: centered PREV / SHEET n / m / NEXT pagination, 50 rows per sheet (10–200
  accepted), then the mono keyboard legend.

**Responsive — the 880px throw.** One breakpoint, `max-width: 880px`: the deck collapses to
one column; the rail goes static above the line with all groups collapsed (JS removes
`[open]` on load); the plate wraps with counts on their own row; the table re-flows to
stacked blocks — `thead` hidden, `table/tbody/tr` display:block, cells hidden except lamp
(absolutely placed left), company, title, and throws, with the `.m-meta` inline strip
(field, location, class, citizenship) appearing under the title. Throws are always visible
on mobile (no hover). Scan input bumps to 16px (prevents mobile zoom-on-focus). Rail legend
and keyboard footer are hidden.

**Motion.** Exactly one authored moment: **the repack** — on every page render the line's
rows settle in with `repack .22s cubic-bezier(.16,1,.3,1) backwards`, staggered 6ms per row
via `nth-child` delays 1–52 (rows beyond 52 fall back to the 470ms base delay). It is
wrapped in `@media (prefers-reduced-motion: no-preference)`. Everything else is a
functional transition of 0.12–0.25s (levers, hovers, toast slide, pip throw) plus the 0.7s
alternating `pend` opacity pulse while a status write is in flight.

**The One Moment Rule.** New motion may tune the repack; it may not add a second authored
moment. Functional transitions stay at or under 0.25s.

## Elevation & Depth

Depth is machined, not floated. The system layers its four enamel grounds and cuts seams
between them; it does not stack drop shadows. The single exception is the legend plate's
`0 6px 18px rgba(0,0,0,.35)` drop — the plate physically overhangs the deck. Everything
else conveys depth with inset shadows: recessed wells (`0 1px 4px rgba(0,0,0,.4) inset` on
active plate-counts, `0 1px 2px rgba(0,0,0,.6) inset` in lamp sockets and pip slots) read
as cut into the enamel.

### Shadow Vocabulary
- **Plate drop** (`box-shadow: 0 6px 18px rgba(0,0,0,.35)`): legend plate only.
- **Ridge inset** (`0 1px 0 #2C3D33 inset` variants): the 1px machined highlight on the
  raised side of a seam (plate top edge, column-head bottom edge, rail right edge).
- **Socket recess** (`0 1px 2px rgba(0,0,0,.6) inset`): unlit lamp wells and pip tracks.
- **Lamp glow** — row lamps are lit, not radiating (`0 0 2px` at ~.3 alpha); the full
  `0 0 6px 1px rgba(255,176,0,.55)` radiance is reserved for the plate NEW indicator (the
  page's single glowing element). Legacy full-glow values (`rgba(70,201,120,.5)` /
  `rgba(242,247,240,.45)`): emitted light from lit amber/green/white lamps; the thrown pip
  carries `0 0 5px rgba(242,247,240,.6)`.

### Named Rules
**The Groove-and-Ridge Rule.** Every structural edge is a seam: a groove line (`#0A100D`)
on the recessed side, a one-pixel ridge highlight (`#2C3D33`) inset on the raised side.
New panels must be seamed, not shadowed.

**The Light-Is-Signal Rule.** Outward glow belongs exclusively to lit lamps and the thrown
pip. Decorative glows, glassy blurs, and hover drop shadows do not exist in this world.

## Shapes

Tight machined radii: 3px on the smallest stamped elements (code chips, throw buttons), 4px
on controls (levers, plate-counts, inputs, clear/sheet buttons), 5px on standalone plates
(NEW indicator, toast). Circles are reserved for lamps (11px, `border-radius: 50%`); the
lever pip is an 18×8px rounded slot with a 6px square-round slider. No pills, no large
radii, no clipped imagery — there is no imagery. Borders are always 1px, in `ridge` (raised)
or `groove` (recessed). Rail group summaries carry a CSS-triangle disclosure caret
(`width: 0; height: 0; border-left: 5px solid var(--etch-faint)` rotated 90° when open) —
the detector's side-tab warning on this rule is an adjudicated false positive, persisted in
`.impeccable/config.json` `ignoreValues`.

## Components

### Block Lamp (signature)
The 11px circular state indicator leading every row and the NEW counter. Unlit: a groove
socket with recess shadow. `lit-amber` / `lit-green` / `lit-white`: solid signal fill plus
its glow. `closed` (rejected): near-black `#050807` with a faint etched ring inside — an
extinguished bulb, not a colored state. Render-side `lamp()` and client-side `lampClass()`
must stay in sync; every lamp carries an `aria-label`.

### Throws (status buttons)
- **Shape:** 24×24px, chip radius (3px), Chivo Mono key-caps S / A / I / O / X.
- **Rest:** groove ground, etch-dim text, ridge border; the whole group idles at
  `opacity: .35` and wakes on row hover/selection/focus-within (or when one is on).
- **On:** hard inversion — etch ground, enamel-0 text, weight 700, `aria-pressed="true"`.
- **Pending:** the 0.7s `pend` opacity pulse while the PUT is in flight; on failure the
  toast reports "SIGNAL FAILURE" in-world.
- Pressing the active throw again clears the status (returns the row to untouched; an
  amber-fresh row regains its wash).

### Levers (filter rows)
- **Style:** full-width rows in the rail; slide-switch pip + tracked label + mono count.
  Etch-dim at rest, enamel-3 wash + etch on hover.
- **On:** pip slides right (`left: 1px → 11px`, `cubic-bezier(.2,.9,.3,1)`) and lights
  white with glow; label brightens to etch; `aria-current="true"`. Selection state lives in
  the pip and ink — the row ground does not invert.
- Filters are links that re-render the page (toggle semantics via querystring); any filter
  change resets to sheet 1.

### Buttons (clear / sheets)
- **Shape:** control radius (4px), ridge border, tracked-caps label (10.5px / 700 / 0.16em).
- **Rest:** transparent ground, etch-dim text. **Hover:** border and text turn amber — the
  only buttons that borrow the attention hue. **Off** (disabled sheet): `opacity: .3`.

### Chips
- **Code chip** (field codes like SWE, ML/AI): Chivo Mono 9.5px/600, etch-dim, 1px ridge
  border, 3px radius, `2px 5px` padding. Informational only — no selected state.
- **Plate-count** (header type counts): stacked mono number over 9px tracked label;
  transparent at rest, enamel-3 on hover; active = ridge border + enamel-3 + recess inset.

### Inputs
- **Scan input:** groove ground (recessed well), ridge border, control radius, Chivo Mono
  11.5px, etch text, etch-faint placeholder ("SCAN — title / company"), amber caret.
  **Focus:** the global ring — `outline: 2px solid #FFB000; outline-offset: 2px`. Hidden
  inputs carry all other active filters so a scan never drops thrown levers.

### Navigation
- **Legend plate:** the identity header — enamel-2→1 gradient, groove bottom seam, ridge
  inset top, the plate drop shadow. Holds the h1, live per-type counts, and the NEW
  indicator (lamp + mono count + "NEW / 3D"), which inverts to solid amber when the
  new-only filter is thrown.
- **Interlocking rail:** the sticky left filter stack (see Levers); groups are native
  `<details>` with tracked-caps summaries and triangle carets; "ALL STATES" nests as a
  quieter `more` disclosure; the amber/white/green/dark lamp legend anchors the bottom.

### The Line (rows)
Dense table rows, 42px, groove-seamed. Hover/keyboard-selected rows wash enamel-2 with a 2px
amber inset bar at the left edge (`box-shadow: 2px 0 0 #FFB000 inset`); the same treatment
serves `:focus-visible`. Fresh (new + untouched) rows carry a faint amber wash
(no background wash — the amber lamp alone carries "awaiting decision"; one signal per
fact). Closed (rejected) rows drop to `opacity: .45` with a line-through
title. Deadline cell: "DUE MM-DD" (red when inside 14 live days), "CLOSED MM-DD"
(etch-faint) after; otherwise the first-seen date. Grad windows render as `'26–'27` /
`'28+` / `≤'27`. The board is keyboard-first: j/k move, ⏎ opens, s/a/i/o/x throw, u clears
(the mono footer legend documents this). Row dividers "NEW ON THE BOARD" (amber gradient
band, amber-soft legend, block/day counts) and "EARLIER" appear only on the default
first-seen sort without new-only.

### Toast
Bottom-center fixed plate: enamel-3, ridge border, panel radius (5px), 12px text. Slides up
`0.25s cubic-bezier(.2,.9,.3,1)`, auto-hides after 3.5s, `role="status"` +
`aria-live="polite"`. Currently used only for write failures.

### Empty State
Centered on the line: "NO BLOCKS ON THE LINE" (18px / 700 / 0.2em, etch-dim), one
etch-faint sentence, and the RESET ALL LEVERS clear-button when filters are thrown.

**The Hard Inversion Rule.** A committed state is a full figure-ground flip — dark ground
gains light fill and dark text (throw.on, new-ind.on, ::selection). Never a tinted or
half-toned selected state.

## Do's and Don'ts

### Do:
- **Do** keep every hue on its one job: amber = awaiting decision + interaction chrome,
  white = held, green = in flight, red = live deadline (< 14 days, unexpired) only.
- **Do** seam new panels with the groove (`#0A100D`) + ridge (`#2C3D33`) pair and the four
  enamel steps; depth is machined, never floated.
- **Do** set every number in Chivo Mono with `tabular-nums`, and every label as tracked
  uppercase (0.14–0.2em) in an etch ink.
- **Do** make committed states hard inversions (light ground, dark text) with
  `aria-pressed` / `aria-current` kept truthful.
- **Do** theme browser chrome in-world on any new surface: amber selection and caret,
  enamel scrollbar, the 2px amber `:focus-visible` ring.
- **Do** write microcopy in the dispatcher's voice — blocks, levers, sheets, lines, signal
  failure — in tracked caps for legends.
- **Do** wrap any future motion in `prefers-reduced-motion` and keep functional
  transitions at or under 0.25s.

### Don't:
- **Don't** introduce white cards, light-mode surfaces, brand gradients, or imagery — the
  world is backlit enamel, and the deck's single radial backlight is the only ambient
  light.
- **Don't** color a rejected or expired thing red — closed states lose light (dark lamp,
  reduced opacity, etch-faint ink), they never gain a hue.
- **Don't** add outward glows or drop shadows beyond the plate drop and lamp/pip glows.
- **Don't** add a third typeface, a radius beyond 5px (lamps excepted), or a non-1px
  border.
- **Don't** author a second motion moment; the repack owns arrival.
- **Don't** let render-side `lamp()` and client-side `lampClass()` drift apart when adding
  states — they are the same rule in two runtimes.
