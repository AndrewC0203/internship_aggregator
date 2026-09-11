# Dedup key simulation — what would each candidate key actually collapse?

**Date:** 2026-09-11
**Data:** 1,817 active listings (post Dedup v1 / Decision 15, all three sources live)
**Method:** read-only simulation — every candidate key applied to the same active set,
counting clusters (>1 row sharing a key) and "extra rows" (rows beyond the first in each
cluster, i.e. what a user scrolls past twice). Facets computed with the current
`resolveLocation()` (after the Washington-D.C. fix, see below).

## Results

| Candidate key | Clusters | Extra rows | Dup rate |
|---|---|---|---|
| current: (company, title, raw location) | 0 | 0 | 0.0% |
| (company, title) only | 137 | 218 | 12.0% |
| (company, title, country facet) | 53 | 76 | 4.2% |
| (company, title, country+state facet) | 12 | 14 | **0.8%** |
| (normalized company, lowercased title, country+state facet) | 13 | 15 | 0.8% |

Company-name normalization (strip `Inc/LLC/...`, casefold) moved the number by **one
cluster** — cross-source company aliasing is a real gap in principle but empirically
negligible today (companies run one ATS). Deferred.

## The decisive finding: the 12% is mostly NOT duplicates

Decomposing the 137 (company, title) clusters by what location normalization does to them:

**1. Location aliasing the facet key would merge: 12 clusters, 14 rows (0.8%).**
And even this list is majority FALSE merges at state granularity:

- True aliases (~4): Amtech "India" vs "Bangalore"; Compeer "WI-Sun Prairie; IL-Bloomington"
  vs the same two cities reordered; Anduril "Broomfield; Fort Collins" vs "Broomfield"
  (subset); arguably 7shifts "Remote (Canada)" vs "Toronto, ON, Saskatoon, SK".
- False merges (~8): SpaceX Hawthorne vs Palo Alto (both CA — different offices), Figure
  San Jose vs LA, SpaceX Palo Alto vs Irvine, Graphcore London/Bristol/Cambridge (all GB),
  Culture Amp Melbourne vs Sydney (both AU), Palantir Dubai vs Abu Dhabi (both AE),
  Doctolib Bologna vs Milano (both IT). The facet arrays are country+US-state; everywhere
  else "same facet" collapses city-level distinctions that are real.

**2. Genuine geographic variants: 131 clusters, 212 rows (11.7%).**
Same (company, title), different facets — different opportunities: Palantir Core
Interfaces NY vs CA, Sezzle interns in Colombia vs Peru, Affirm Spain vs Poland. Includes
the Meridial 6-country spam: those six rows facet to six different countries, so **no
location normalization ever collapses them** — they are a presentation problem, not a key
problem.

## Conclusion drawn (see DECISIONS.md Decision 28)

Location normalization — the assumed fix — addresses 0.8 of the 12 points, and applying it
inside the dedup key would destroy real city-level signal to get there. The other 11.7
points are true variants that belong in ONE search-result card with N location chips, not
N cards — a presentation-layer group-by (company, title), with no stored data destroyed
and the dup metric redefined to what the user actually sees.

## Bycatch: resolver bug + stale facets

The simulation exposed `resolveLocation("Washington, D.C.") -> {US, WA}`: comma-tokenizing
shreds the city name into "washington" (matches the STATE dictionary) before the city
dictionary can see the full phrase. Fixed with a pre-tokenization phrase match in
`location.ts`; 24 D.C. rows were faceted as Washington state in the live DB.

Fixing stored rows required re-deriving facets, which surfaced a second gap: facets are
computed at persist time and frozen (seenKeeps never re-evaluate), so every resolver
improvement strands already-persisted rows on stale facets. `src/backfill-locations.ts`
(new, idempotent, re-runnable) re-derives all rows; first run updated **241** rows — the
24 D.C. rows plus ~217 stranded on pre-dictionary-widening facets ("Mexico City" -> no
facet). Run it after any `location.ts` change.
