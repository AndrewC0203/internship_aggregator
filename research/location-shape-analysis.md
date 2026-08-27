# Location string shapes — input to the location-filter decision

2026-08-27. Measured over all active listings (1,817 rows, 762 distinct location strings) with
a crude shape classifier (scratch script; buckets are first-match, so counts are indicative,
not exact).

## Shape distribution (listing-weighted)

| shape | rows | notes |
|---|---|---|
| `City, ST` (US 2-letter code as last comma token) | 232 (13%) | "New York, NY" — trivially parseable |
| contains a US state full name | 309 (17%) | "Atlanta, Georgia, United States" |
| contains a recognizable country name/alias | 493 (27%) | "Copenhagen, Denmark", "United States of America" |
| remote-flavored | 54 (3%) | "Remote", "Remote - US", "Remote within the U.S.", "Colombia, Remote" |
| multi-location strings | 89 (5%) | see below — the schema-shaping finding |
| unresolved by the crude pass | 640 (35%) | mostly foreign city-only ("London" ×34, "Hong Kong" ×28, "Taipei", "Bangkok") and US city-only ("San Francisco" ×20, "Denver") |

## Findings that constrain the design

1. **Multi-location is real and mixed-jurisdiction.** Examples:
   `London, UK; Ontario, CAN; Remote-Friendly, United States; San Francisco, CA` and
   `San Francisco, CA | New York City, NY | Seattle, WA`. One listing can legitimately span
   several US states AND several countries → a single `country` + `us_state` column pair
   CANNOT represent the data. Storage must be multi-valued (arrays).
2. **The province-code trap is present, not hypothetical**: `Toronto, ON`, `Saskatoon, SK`,
   `Montréal, Québec`, `Ontario, CAN` — a naive "2-letter token = US state" rule mis-buckets
   Canadian postings. Any parser must check Canadian province codes BEFORE US state codes.
3. **The unresolved tail is dictionary-shaped, not model-shaped.** The bulk of the 35% is a
   small set of high-frequency foreign hub cities and a handful of US city-only strings —
   ~50–100 city→country/state dictionary entries would cover most of it deterministically.
4. **Delimiters are inconsistent** (`;`, `|`, `/`, and one `", "`-separated triple-city
   string) and some segments are regions, not places: `Home based - EMEA/APAC/Americas`,
   `Latam`, `AMER`, `Mid-Atlantic Region`, `San Francisco Bay Area` — these have no single
   country and should resolve to "unknown", not a guess.
5. **`US-XX-City` structured pattern exists** (`US-VA-Arlington`, and a 9-segment pipe string
   of them) — free to parse exactly.
6. 762 distinct strings vs 1,817 rows → any expensive resolution (model or manual) should run
   per DISTINCT string, not per listing (2.4× dedup for free, and growing with scale).

## Implication (proposal at time of writing; decision pending)

Deterministic-first hybrid: pure parser (multi-split → structured patterns → province guard →
state/country/city dictionaries) writing multi-valued `loc_countries[]` / `loc_us_states[]`,
raw `location` kept untouched (the Decision 15 dedup key depends on it). Model involvement, if
any, only as a fallback for strings the parser can't resolve, constrained to enum values, run
per distinct string. Regions/bare-"Remote" stay unresolved rather than guessed.

## Parser coverage after implementation (2026-08-27, Decision 19)

Measured `resolveLocation()` over the same 1,817 active rows:

| metric | value |
|---|---|
| resolved to ≥1 country | 1,680 (**92.5%**) |
| US rows with ≥1 state facet | 743 / 814 (**91.3%**) |
| unresolved | 137 rows (7.5%), 61 distinct strings |

The unresolved tail is dominated by strings carrying NO place information in the location
field itself: "Hybrid" (19), "Remote" (17), "Home based - Worldwide" (12), "Flexible - Any
SpaceX Site" (8), regions (EMEA/APAC/Americas), "Multiple Locations Available", "In-Office".
A model reading only the location string could not resolve these either — they'd need the
DESCRIPTION body (e.g. SpaceX sites are all US). Conclusion: the deferred model fallback in
Decision 19 is NOT currently worth building for ~7.5% residue that is mostly genuinely
location-less; revisit only if the unresolved share grows with new sources, and if built, it
should read the description, not just the location string.

Fix-cycle notes (all pinned in location.test.ts): parenthetical handling must SPLIT, not
delete — "(Hybrid)" is an annotation but "(United States)" is the place; the " or " segment
delimiter must be case-insensitive ("Beijing OR Shanghai") and whitespace-bounded so it never
touches a comma-attached Oregon "OR".
