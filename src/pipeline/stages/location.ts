// Deterministic location resolver (Decision 19). Raw free-text `location` string -> the two
// facet arrays the UI filters on: ISO-3166 alpha-2 countries + US state codes.
//
// Same fact-extractor stance as experience.ts / grad-date.ts: PURE code, testable, no model.
// Decision 19 chose deterministic-first (Option 3's first half) because the measured mess is
// dictionary-shaped, not judgment-shaped (research/location-shape-analysis.md): ~60% of rows
// are structured ("City, ST", state/country names) and most of the rest is a small set of
// high-frequency hub cities. The failure mode is chosen deliberately: an UNRESOLVED string
// yields empty arrays and drops out of the location filters (visible, countable, fixable by
// widening a dictionary) — it is never guessed into the wrong state, which would be invisible.
// A model fallback for the residue is the deferred second half of Decision 19, only if the
// unresolved rate measured after this parser still warrants it.
//
// THE ORDERING INVARIANT: Canadian province codes are checked BEFORE US state codes. The
// measured data contains "Toronto, ON" and "Saskatoon, SK" — a bare "2 uppercase letters after
// a comma = US state" rule would file Canadian listings under US states. Any new
// abbreviation scheme added here must slot in above the US-state check for the same reason.

export interface ResolvedLocation {
  countries: string[]; // ISO-3166 alpha-2, sorted, deduped
  usStates: string[]; // USPS codes + DC, sorted, deduped
}

// Fold case and accents so "Montréal"/"Bogotá"/"São Paulo" hit plain-ascii dictionary keys.
const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

const US_STATE_CODES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  ),
);

const US_STATE_BY_NAME: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

// Checked BEFORE US state codes — see the ordering invariant above.
const CA_PROVINCE_CODES = new Set("ON BC QC AB MB SK NS NB NL PE YT NT NU".split(" "));
const CA_PROVINCE_NAMES = new Set([
  "ontario", "british columbia", "quebec", "alberta", "manitoba", "saskatchewan",
  "nova scotia", "new brunswick", "newfoundland", "newfoundland and labrador",
  "prince edward island", "yukon", "northwest territories", "nunavut",
]);

// 2-letter tokens that are countries, not states — must be consulted in the same exact-token
// position as state codes ("Remote - US" ends in a token that LOOKS like a state code).
const TWO_LETTER_COUNTRY: Record<string, string> = { US: "US", UK: "GB", HK: "HK", SG: "SG" };

// Country names + the aliases observed in real data ("CAN", "U.S.A.", "Korea"). Keys are
// norm()'d. Alpha-2 values throughout; UI maps codes to display names.
const COUNTRY_BY_NAME: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US", "u.s.": "US",
  "u.s.a.": "US", america: "US",
  "united kingdom": "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB",
  canada: "CA", can: "CA",
  ireland: "IE", australia: "AU", "new zealand": "NZ", germany: "DE", france: "FR",
  netherlands: "NL", holland: "NL", belgium: "BE", spain: "ES", portugal: "PT", italy: "IT",
  switzerland: "CH", austria: "AT", poland: "PL", "czech republic": "CZ", czechia: "CZ",
  romania: "RO", hungary: "HU", greece: "GR", denmark: "DK", sweden: "SE", norway: "NO",
  finland: "FI", estonia: "EE", ukraine: "UA", turkey: "TR", serbia: "RS", bulgaria: "BG",
  croatia: "HR", slovakia: "SK", slovenia: "SI", lithuania: "LT", latvia: "LV",
  india: "IN", pakistan: "PK", bangladesh: "BD", "sri lanka": "LK", nepal: "NP",
  china: "CN", "hong kong": "HK", taiwan: "TW", japan: "JP", korea: "KR",
  "south korea": "KR", singapore: "SG", malaysia: "MY", indonesia: "ID", thailand: "TH",
  vietnam: "VN", philippines: "PH",
  israel: "IL", "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA", qatar: "QA",
  egypt: "EG", nigeria: "NG", kenya: "KE", "south africa": "ZA", ghana: "GH", morocco: "MA",
  brazil: "BR", brasil: "BR", mexico: "MX", argentina: "AR", colombia: "CO", chile: "CL", peru: "PE",
  uruguay: "UY", ecuador: "EC", panama: "PA", "costa rica": "CR", guatemala: "GT",
  georgia_country: "GE", // unreachable via the word "georgia" (US state wins); kept for Tbilisi
};

// City dictionaries: ONLY unambiguous, high-frequency entries. Deliberately EXCLUDED because
// two big referents exist and a wrong state/country is worse than an unresolved one:
// Cambridge (MA/UK), Vancouver (WA/BC), Portland (OR/ME), Springfield (everywhere).
const US_CITY_BY_NAME: Record<string, string> = {
  "new york city": "NY", nyc: "NY", brooklyn: "NY",
  "san francisco": "CA", "san francisco bay area": "CA", "los angeles": "CA",
  "san jose": "CA", "san diego": "CA", "palo alto": "CA", "mountain view": "CA",
  sunnyvale: "CA", "menlo park": "CA", cupertino: "CA", oakland: "CA", irvine: "CA",
  seattle: "WA", redmond: "WA", bellevue: "WA",
  austin: "TX", dallas: "TX", houston: "TX",
  chicago: "IL", boston: "MA", atlanta: "GA", miami: "FL", denver: "CO", boulder: "CO",
  phoenix: "AZ", philadelphia: "PA", pittsburgh: "PA", "salt lake city": "UT",
  nashville: "TN", charlotte: "NC", raleigh: "NC", durham: "NC", "ann arbor": "MI",
  minneapolis: "MN", "st. louis": "MO", "washington dc": "DC", "washington, d.c.": "DC",
  "washington d.c.": "DC",
};

const WORLD_CITY_BY_NAME: Record<string, string> = {
  london: "GB", manchester: "GB", edinburgh: "GB", dublin: "IE", paris: "FR",
  berlin: "DE", munich: "DE", amsterdam: "NL", brussels: "BE", zurich: "CH", geneva: "CH",
  vienna: "AT", madrid: "ES", barcelona: "ES", lisbon: "PT", porto: "PT", milan: "IT",
  warsaw: "PL", krakow: "PL", prague: "CZ", bucharest: "RO", athens: "GR", istanbul: "TR",
  stockholm: "SE", copenhagen: "DK", oslo: "NO", helsinki: "FI", malmo: "SE",
  budapest: "HU", belgrade: "RS", sofia: "BG", montpellier: "FR", lyon: "FR",
  beijing: "CN", shanghai: "CN", shenzhen: "CN", jerusalem: "IL", haifa: "IL",
  toronto: "CA", montreal: "CA", ottawa: "CA", waterloo: "CA", calgary: "CA",
  "tel aviv": "IL", dubai: "AE",
  bangalore: "IN", bengaluru: "IN", mumbai: "IN", hyderabad: "IN", "new delhi": "IN",
  delhi: "IN", pune: "IN", chennai: "IN", gurgaon: "IN",
  tokyo: "JP", seoul: "KR", taipei: "TW", taoyuan: "TW", bangkok: "TH",
  "kuala lumpur": "MY", jakarta: "ID", manila: "PH", hanoi: "VN", "ho chi minh city": "VN",
  karachi: "PK", lahore: "PK", tbilisi: "GE",
  sydney: "AU", melbourne: "AU", auckland: "NZ",
  "sao paulo": "BR", "rio de janeiro": "BR", "mexico city": "MX", "buenos aires": "AR",
  bogota: "CO", lima: "PE", santiago: "CL", "panama city": "PA", montevideo: "UY",
  lagos: "NG", nairobi: "KE", cairo: "EG", "cape town": "ZA", johannesburg: "ZA",
};

// Last-resort scan for a segment where no comma-token matched anything: look for NAMES (never
// 2-letter codes — substring code matching is how "IN"/"OR" false hits happen) as
// word-bounded phrases in the whole segment. Catches "Remote within the U.S.",
// "San Francisco Bay Area", "Office Based - Taipei, Taiwan"-style prose.
const scanSegment = (seg: string, countries: Set<string>, usStates: Set<string>): void => {
  const text = norm(seg);
  // "u.s." / "usa" prose forms first (dots make them miss the dictionaries' exact keys).
  if (/\bu\.?s\.?a?\.?\b/.test(text.replace(/\./g, ""))) countries.add("US");
  for (const name of CA_PROVINCE_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(text)) countries.add("CA");
  }
  for (const [name, code] of Object.entries(US_STATE_BY_NAME)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      usStates.add(code);
      countries.add("US");
    }
  }
  for (const [name, code] of Object.entries(COUNTRY_BY_NAME)) {
    if (name.includes("_")) continue; // synthetic keys (georgia_country) are not scannable text
    if (new RegExp(`\\b${name.replace(/\./g, "\\.")}\\b`).test(text)) countries.add(code);
  }
  for (const [name, code] of Object.entries(US_CITY_BY_NAME)) {
    if (new RegExp(`\\b${name.replace(/[.,]/g, "\\$&")}\\b`).test(text)) {
      usStates.add(code);
      countries.add("US");
    }
  }
  for (const [name, code] of Object.entries(WORLD_CITY_BY_NAME)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) countries.add(code);
  }
};

export function resolveLocation(location: string | null): ResolvedLocation {
  const countries = new Set<string>();
  const usStates = new Set<string>();
  if (!location || !location.trim()) return { countries: [], usStates: [] };

  // Segment on the multi-location delimiters observed in real data: ";", "|", and the prose
  // " or " in either case ("Albuquerque, NM or Oak Ridge, TN", "Beijing OR Shanghai" — the
  // surrounding-whitespace requirement is what keeps this from ever touching a comma-attached
  // Oregon "OR" token). NOT on "/" at this level — it appears inside single locations
  // ("Bogota / CUN / Colombia"), which token-splitting below already handles.
  for (const rawSeg of location.split(/[;|]|\s+or\s+/i)) {
    // Parentheses become token delimiters, not deletions: they hold annotations in
    // "Redwood City, CA (Hybrid)" but the actual place in "Remote (United States)" — splitting
    // handles both (the annotation fragment just matches nothing), deleting broke the latter.
    let seg = rawSeg.replace(/[()]/g, ",").trim();
    if (!seg) continue;

    // "US-VA-Arlington" / "US-Remote" structured prefix: country is stated; the remainder
    // falls through to normal token matching so the state still resolves.
    if (/^US[-–]/.test(seg)) {
      countries.add("US");
      seg = seg.replace(/^US[-–]/, "");
    }

    let matchedAny = false;
    // "Washington, D.C." — comma-tokenizing shreds this one city name into "washington"
    // (which then matches Washington STATE) + "d.c." (which matches nothing), filing D.C.
    // listings under WA. Resolve the phrase before the token loop ever sees it and cut it
    // out of the segment; "Seattle, Washington" never matches (no trailing d/c tokens).
    seg = seg.replace(/washington[\s,]+d\.?\s*c\.?/gi, () => {
      countries.add("US");
      usStates.add("DC");
      matchedAny = true;
      return "";
    });
    // Tokens split on comma, slash, and dash. Dash-splitting is what turns "VA-Arlington"
    // and "Remote - US" into matchable tokens; it also shreds prose like "Remote-Friendly",
    // whose fragments simply match nothing (harmless).
    for (const part of seg.split(/[,/–—-]/).map((p) => p.trim()).filter(Boolean)) {
      // Exact 2-letter uppercase tokens: country aliases and CANADIAN PROVINCES before US
      // states (the Toronto-ON trap), and only ever as exact tokens, never substrings.
      if (/^[A-Z]{2}$/.test(part)) {
        if (TWO_LETTER_COUNTRY[part]) { countries.add(TWO_LETTER_COUNTRY[part]); matchedAny = true; }
        else if (CA_PROVINCE_CODES.has(part)) { countries.add("CA"); matchedAny = true; }
        else if (US_STATE_CODES.has(part)) { usStates.add(part); countries.add("US"); matchedAny = true; }
        continue;
      }
      const key = norm(part);
      if (CA_PROVINCE_NAMES.has(key)) { countries.add("CA"); matchedAny = true; continue; }
      // "Georgia" the US state shadows Georgia the country by choice: in an ATS-listing corpus
      // the state is overwhelmingly the referent (observed: "Atlanta, Georgia, United States").
      if (US_STATE_BY_NAME[key]) { usStates.add(US_STATE_BY_NAME[key]); countries.add("US"); matchedAny = true; continue; }
      if (COUNTRY_BY_NAME[key]) { countries.add(COUNTRY_BY_NAME[key]); matchedAny = true; continue; }
      if (US_CITY_BY_NAME[key]) { usStates.add(US_CITY_BY_NAME[key]); countries.add("US"); matchedAny = true; continue; }
      if (WORLD_CITY_BY_NAME[key]) { countries.add(WORLD_CITY_BY_NAME[key]); matchedAny = true; continue; }
    }

    // Nothing token-matched → one prose scan. Regions ("EMEA", "Latam", "Worldwide") and bare
    // "Remote" match nothing anywhere by design: unresolved, not guessed.
    if (!matchedAny) scanSegment(seg, countries, usStates);
  }

  return { countries: [...countries].sort(), usStates: [...usStates].sort() };
}
