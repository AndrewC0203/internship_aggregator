import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocation } from "./location.js";

// Every fixture here is a REAL location string from the active DB (see
// research/location-shape-analysis.md) — this suite is the parser's contract with measured
// data, not with hypothetical formats.

test("City, ST — the dominant US shape", () => {
  assert.deepEqual(resolveLocation("New York, NY"), { countries: ["US"], usStates: ["NY"] });
});

test("the Toronto-ON trap: Canadian province codes never read as US states", () => {
  assert.deepEqual(resolveLocation("Toronto, ON"), { countries: ["CA"], usStates: [] });
  assert.deepEqual(resolveLocation("Toronto, ON, Saskatoon, SK"), { countries: ["CA"], usStates: [] });
  assert.deepEqual(resolveLocation("Montréal, Québec"), { countries: ["CA"], usStates: [] });
  assert.deepEqual(resolveLocation("Ontario, CAN"), { countries: ["CA"], usStates: [] });
});

test("state names and full 'City, State, Country' forms", () => {
  assert.deepEqual(resolveLocation("Atlanta, Georgia, United States"), {
    countries: ["US"],
    usStates: ["GA"],
  });
});

test("multi-location strings union across every segment and jurisdiction", () => {
  assert.deepEqual(
    resolveLocation("London, UK; Ontario, CAN; Remote-Friendly, United States; San Francisco, CA"),
    { countries: ["CA", "GB", "US"], usStates: ["CA"] },
  );
  assert.deepEqual(
    resolveLocation("San Francisco, CA | New York City, NY | Seattle, WA"),
    { countries: ["US"], usStates: ["CA", "NY", "WA"] },
  );
  // lowercase prose " or " as a delimiter
  assert.deepEqual(resolveLocation("Alameda, CA, Albuquerque, NM or Oak Ridge, TN"), {
    countries: ["US"],
    usStates: ["CA", "NM", "TN"],
  });
});

test("US-XX-City structured prefix resolves both country and state", () => {
  assert.deepEqual(resolveLocation("US-VA-Arlington"), { countries: ["US"], usStates: ["VA"] });
  assert.deepEqual(resolveLocation("US-Washington DC"), { countries: ["US"], usStates: ["DC"] });
});

test("hub cities resolve without an explicit state/country", () => {
  assert.deepEqual(resolveLocation("San Francisco"), { countries: ["US"], usStates: ["CA"] });
  assert.deepEqual(resolveLocation("San Francisco Bay Area"), { countries: ["US"], usStates: ["CA"] });
  assert.deepEqual(resolveLocation("London"), { countries: ["GB"], usStates: [] });
  assert.deepEqual(resolveLocation("Hong Kong, Hong Kong"), { countries: ["HK"], usStates: [] });
  assert.deepEqual(resolveLocation("Bogotá, Colombia"), { countries: ["CO"], usStates: [] });
});

test("remote-with-country resolves; bare remote and regions stay UNRESOLVED, never guessed", () => {
  assert.deepEqual(resolveLocation("Remote - US"), { countries: ["US"], usStates: [] });
  assert.deepEqual(resolveLocation("Remote within the U.S."), { countries: ["US"], usStates: [] });
  assert.deepEqual(resolveLocation("Colombia, Remote"), { countries: ["CO"], usStates: [] });

  const unresolved = { countries: [], usStates: [] };
  assert.deepEqual(resolveLocation("Remote"), unresolved);
  assert.deepEqual(resolveLocation("Home based - Worldwide"), unresolved);
  assert.deepEqual(resolveLocation("Home Based - APAC"), unresolved);
  assert.deepEqual(resolveLocation("Latam"), unresolved);
  assert.deepEqual(resolveLocation("AMER"), unresolved);
  assert.deepEqual(resolveLocation("Mid-Atlantic Region"), unresolved);
});

test("ambiguous city names are deliberately absent from the dictionaries", () => {
  // Cambridge (MA vs UK), Vancouver (WA vs BC), Portland (OR vs ME): a wrong facet is worse
  // than an empty one, so these resolve to nothing rather than to a coin-flip.
  const unresolved = { countries: [], usStates: [] };
  assert.deepEqual(resolveLocation("Cambridge"), unresolved);
  assert.deepEqual(resolveLocation("Vancouver"), unresolved);
  assert.deepEqual(resolveLocation("Portland"), unresolved);
});

test("slash-delimited single locations and null input", () => {
  assert.deepEqual(resolveLocation("Bogota / CUN / Colombia"), { countries: ["CO"], usStates: [] });
  assert.deepEqual(resolveLocation(null), { countries: [], usStates: [] });
  assert.deepEqual(resolveLocation("  "), { countries: [], usStates: [] });
});

test("output is sorted and deduped — stable for tests, diffs, and DB comparisons", () => {
  const twice = resolveLocation("Seattle, WA; Austin, TX; Seattle, WA");
  assert.deepEqual(twice, { countries: ["US"], usStates: ["TX", "WA"] });
});
