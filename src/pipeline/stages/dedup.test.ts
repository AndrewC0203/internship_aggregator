import { test } from "node:test";
import assert from "node:assert/strict";
import { dedup, retireAliasCarriers } from "./dedup.js";
import type { DedupRepo, DedupKeyParts, ExistingCanonical } from "./dedup.js";
import type { NormalizedListing, ListingKey } from "../types.js";

// A fake DedupRepo backed by a plain in-memory array — no Postgres needed, same "unit tests
// don't touch the DB" bar as filter.test.ts. `active` models the current state of `listings`
// (only ACTIVE rows matter to dedup, which is exactly what the real prismaDedupRepo filters
// to with `isListed: true`).
interface FakeRetirement {
  carrier: ListingKey;
  canonical: ListingKey;
  keysToFold: ListingKey[];
}

function fakeRepo(active: ExistingCanonical[]): DedupRepo & {
  merges: Array<[ListingKey, ListingKey[]]>;
  retirements: FakeRetirement[];
} {
  const merges: Array<[ListingKey, ListingKey[]]> = [];
  const retirements: FakeRetirement[] = [];
  const nk = (k: ListingKey) => `${k.source}::${k.sourceExternalId}`;
  return {
    merges,
    retirements,
    async findActiveByKeys(keys: DedupKeyParts[]) {
      const wanted = new Set(keys.map((k) => `${k.company}::${k.title}::${k.location ?? ""}`));
      return active.filter((a) => wanted.has(`${a.company}::${a.title}::${a.location ?? ""}`));
    },
    async mergeDuplicateKeys(target, keysToAdd) {
      merges.push([target, keysToAdd]);
      const row = active.find((a) => nk(a) === nk(target));
      if (row) {
        const byKey = new Map(row.duplicateKeys.map((k) => [nk(k), k]));
        for (const k of keysToAdd) byKey.set(nk(k), k);
        row.duplicateKeys = [...byKey.values()];
      }
    },
    async findActiveByNaturalKeys(keys: ListingKey[]) {
      const wanted = new Set(keys.map(nk));
      return active
        .filter((a) => wanted.has(nk(a)))
        .map((a) => ({ source: a.source, sourceExternalId: a.sourceExternalId }));
    },
    async findActiveCarriersOf(keys: ListingKey[]) {
      const wanted = new Set(keys.map(nk));
      return active
        .filter((a) => a.duplicateKeys.some((k) => wanted.has(nk(k))))
        .map((a) => ({
          source: a.source,
          sourceExternalId: a.sourceExternalId,
          duplicateKeys: a.duplicateKeys,
        }));
    },
    async retireCarrier(carrier, canonical, keysToFold) {
      retirements.push({ carrier, canonical, keysToFold });
      const idx = active.findIndex((a) => nk(a) === nk(carrier));
      if (idx !== -1) active.splice(idx, 1); // delisted rows stop being "active"
    },
  };
}

let n = 0;
function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "greenhouse",
    sourceExternalId: `ext-${++n}`,
    company: "Meridial",
    title: "AI Training Generalist (No Prior Experience Needed)",
    descriptionHtml: "<p>irrelevant</p>",
    descriptionPlain: "irrelevant",
    location: "United States of America",
    department: null,
    employmentType: null,
    workplaceType: null,
    compMin: null,
    compMax: null,
    compCurrency: null,
    compInterval: null,
    publishedAt: null,
    applicationDeadline: null,
    url: "https://example.com/job",
    duplicateKeys: [],
    ...overrides,
  };
}

test("an empty batch is a no-op", async () => {
  const repo = fakeRepo([]);
  assert.deepEqual(await dedup([], repo), []);
});

test("pure noise: identical (company, title, location) collapses to one canonical", async () => {
  // Mirrors the measured audit case: 6 identical Meridial reqs, all US.
  const batch = Array.from({ length: 6 }, () => listing());
  const repo = fakeRepo([]);

  const out = await dedup(batch, repo);

  assert.equal(out.length, 1, "6 identical rows should collapse to 1");
  const survivor = out[0];
  // Deterministic: the lexicographically-smallest sourceExternalId wins.
  const expectedSurvivorId = [...batch].sort((a, b) =>
    a.sourceExternalId.localeCompare(b.sourceExternalId),
  )[0].sourceExternalId;
  assert.equal(survivor.sourceExternalId, expectedSurvivorId);
  assert.equal(survivor.duplicateKeys.length, 5, "the other 5 reqs become suppressed duplicates");
});

test("geographic variants are NOT collapsed — different location means different key", async () => {
  const countries = ["United States", "United Kingdom", "Canada", "Australia", "New Zealand", "Ireland"];
  const batch = countries.map((location) =>
    listing({ title: "Social Media Annotation - Freelance AI Trainer", location }),
  );
  const repo = fakeRepo([]);

  const out = await dedup(batch, repo);

  assert.equal(out.length, 6, "6 distinct countries should remain 6 distinct listings");
  assert.deepEqual(
    out.map((l) => l.duplicateKeys.length),
    [0, 0, 0, 0, 0, 0],
    "none of these are duplicates of each other",
  );
});

test("suppresses a new req against an ALREADY-ACTIVE canonical from a past refresh", async () => {
  // Simulates: refresh N persisted one Meridial req as the canonical; refresh N+1's crawl
  // finds a 2nd, previously-unseen req ID for the exact same role.
  const canonical: ExistingCanonical = {
    source: "greenhouse",
    sourceExternalId: "req-1",
    company: "Meridial",
    title: "AI Training Generalist (No Prior Experience Needed)",
    location: "United States of America",
    duplicateKeys: [],
  };
  const repo = fakeRepo([canonical]);
  const incoming = listing({ sourceExternalId: "req-2" });

  const out = await dedup([incoming], repo);

  assert.deepEqual(out, [], "the new req must not flow on to partition/filter/persist");
  assert.equal(repo.merges.length, 1, "the existing canonical's row should be updated once");
  const [target, added] = repo.merges[0];
  assert.deepEqual(target, { source: "greenhouse", sourceExternalId: "req-1" });
  assert.deepEqual(added, [{ source: "greenhouse", sourceExternalId: "req-2" }]);
});

test("a listing matching its OWN existing active row is not treated as a duplicate of itself", async () => {
  // This is the ordinary "still-live, re-crawled" case that partitionBySeen already handles
  // as a seenKeep — dedup must not suppress it or double-count it against itself.
  const canonical: ExistingCanonical = {
    source: "greenhouse",
    sourceExternalId: "req-1",
    company: "Meridial",
    title: "AI Training Generalist (No Prior Experience Needed)",
    location: "United States of America",
    duplicateKeys: [{ source: "greenhouse", sourceExternalId: "req-2" }],
  };
  const repo = fakeRepo([canonical]);
  const incoming = listing({ sourceExternalId: "req-1" });

  const out = await dedup([incoming], repo);

  assert.equal(out.length, 1, "the listing should pass through, not be dropped");
  assert.equal(out[0].sourceExternalId, "req-1");
  assert.deepEqual(
    out[0].duplicateKeys,
    [{ source: "greenhouse", sourceExternalId: "req-2" }],
    "prior duplicate history must be preserved, not wiped",
  );
  assert.equal(repo.merges.length, 0, "no DB write needed — persist()'s normal update carries this through");
});

test("SELF-HEALING: once the canonical goes inactive, a fresh req for the same role is NOT suppressed", async () => {
  // Decision 9's key invariant: only suppress against a CURRENTLY-ACTIVE canonical. An
  // inactive canonical must not appear in findActiveByKeys (mirrors prismaDedupRepo's
  // `isListed: true` filter), so the incoming listing is treated as brand new and gets its
  // own row — the still-live role resurfaces instead of staying suppressed forever.
  const repo = fakeRepo([]); // canonical is inactive -> repo reports no active match at all
  const incoming = listing({ sourceExternalId: "req-2" });

  const out = await dedup([incoming], repo);

  assert.equal(out.length, 1, "must proceed as a new listing, not be suppressed");
  assert.equal(out[0].sourceExternalId, "req-2");
  assert.deepEqual(out[0].duplicateKeys, []);
});

test("in-batch duplicates found alongside an existing active canonical all merge into it", async () => {
  const canonical: ExistingCanonical = {
    source: "greenhouse",
    sourceExternalId: "req-1",
    company: "Meridial",
    title: "AI Training Generalist (No Prior Experience Needed)",
    location: "United States of America",
    duplicateKeys: [],
  };
  const repo = fakeRepo([canonical]);
  const incoming = [listing({ sourceExternalId: "req-2" }), listing({ sourceExternalId: "req-3" })];

  const out = await dedup(incoming, repo);

  assert.deepEqual(out, [], "both new reqs are duplicates of the existing canonical");
  assert.equal(repo.merges.length, 1);
  const [, added] = repo.merges[0];
  assert.deepEqual(
    added.map((k) => k.sourceExternalId).sort(),
    ["req-2", "req-3"],
  );
});

test("trims whitespace noise in the key but does not fold case or normalize location semantically", async () => {
  const a = listing({ sourceExternalId: "req-1", location: "United States of America " });
  const b = listing({ sourceExternalId: "req-2", location: " United States of America" });
  const repo = fakeRepo([]);

  const out = await dedup([a, b], repo);

  assert.equal(out.length, 1, "whitespace-only differences should still collapse");
});

test("different companies with the same title never collapse", async () => {
  const a = listing({ sourceExternalId: "req-1", company: "Meridial" });
  const b = listing({ sourceExternalId: "req-2", company: "Affirm" });
  const repo = fakeRepo([]);

  const out = await dedup([a, b], repo);

  assert.equal(out.length, 2);
});

// ---- Alias-key dedup (Decision 39): cross-source identity via the ATS key parsed from a ----
// ---- curated feed's URL. Forward pass lives in dedup(); the reverse (retire) runs at    ----
// ---- persist time so a carrier is only ever retired for a copy that actually persisted. ----

const aliasKey = (id: string): ListingKey => ({ source: "greenhouse", sourceExternalId: id });

function simplifyListing(id: string, alias: ListingKey | null): NormalizedListing {
  return listing({
    source: "simplify",
    sourceExternalId: id,
    company: "Cresta",
    title: "Software Engineer Intern",
    location: "SF",
    duplicateKeys: alias ? [alias] : [],
  });
}

test("alias forward: a feed copy of an ACTIVE ATS row is suppressed and folded into it", async () => {
  const ghRow: ExistingCanonical = {
    source: "greenhouse",
    sourceExternalId: "gh-1",
    // Deliberately DIFFERENT strings than the simplify copy writes — the string key must
    // not be what links them.
    company: "Cresta, Inc.",
    title: "Software Engineer Intern (Summer 2026)",
    location: "San Francisco, California, United States",
    duplicateKeys: [],
  };
  const repo = fakeRepo([ghRow]);

  const out = await dedup([simplifyListing("s-1", aliasKey("gh-1"))], repo);

  assert.deepEqual(out, [], "the feed copy must not persist beside its ATS row");
  assert.deepEqual(repo.merges, [
    [{ source: "greenhouse", sourceExternalId: "gh-1" }, [{ source: "simplify", sourceExternalId: "s-1" }]],
  ]);
});

test("alias forward: no active target means the feed copy proceeds, alias intact", async () => {
  const repo = fakeRepo([]);
  const out = await dedup([simplifyListing("s-2", aliasKey("gh-404"))], repo);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].duplicateKeys, [aliasKey("gh-404")]);
  assert.deepEqual(repo.merges, []);
});

test("alias forward: target arriving in the SAME batch absorbs the feed copy in-memory", async () => {
  const gh = listing({
    source: "greenhouse",
    sourceExternalId: "gh-2",
    company: "Cresta, Inc.",
    title: "Software Engineer Intern (Summer 2026)",
    location: "San Francisco, California, United States",
  });
  const repo = fakeRepo([]);

  const out = await dedup([gh, simplifyListing("s-3", aliasKey("gh-2"))], repo);

  assert.equal(out.length, 1);
  assert.equal(out[0].sourceExternalId, "gh-2");
  assert.deepEqual(out[0].duplicateKeys, [{ source: "simplify", sourceExternalId: "s-3" }]);
  assert.deepEqual(repo.merges, [], "in-batch fold needs no DB write — persist carries it");
});

test("alias forward: a feed copy with no alias flows through untouched", async () => {
  const repo = fakeRepo([]);
  const out = await dedup([simplifyListing("s-4", null)], repo);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].duplicateKeys, []);
});

test("retire: persisting the ATS copy delists an active feed carrier and inherits its keys", async () => {
  const carrier: ExistingCanonical = {
    source: "simplify",
    sourceExternalId: "s-5",
    company: "Cresta",
    title: "Software Engineer Intern",
    location: "SF",
    duplicateKeys: [aliasKey("gh-9")],
  };
  const repo = fakeRepo([carrier]);

  const retired = await retireAliasCarriers([aliasKey("gh-9")], repo);

  assert.equal(retired, 1);
  assert.deepEqual(repo.retirements, [
    {
      carrier: { source: "simplify", sourceExternalId: "s-5" },
      canonical: aliasKey("gh-9"),
      // The carrier's own key folds in; its alias entry — the canonical's OWN key — must not.
      keysToFold: [{ source: "simplify", sourceExternalId: "s-5" }],
    },
  ]);
});

test("retire: no active carrier is a no-op", async () => {
  const repo = fakeRepo([]);
  assert.equal(await retireAliasCarriers([aliasKey("gh-10")], repo), 0);
  assert.deepEqual(repo.retirements, []);
});

test("retire: a row is never treated as its own carrier", async () => {
  // A GH canonical that already folded a feed copy holds a simplify key in duplicateKeys.
  // Persisting that SIMPLIFY key again must not retire the GH row (retire only ever fires
  // for a carrier of a DIFFERENT source than the persisted key's owner-row... the guard is
  // that the carrier's own natural key differs from every persisted key).
  const ghRow: ExistingCanonical = {
    source: "greenhouse",
    sourceExternalId: "gh-11",
    company: "Cresta, Inc.",
    title: "SWE Intern",
    location: "SF",
    duplicateKeys: [{ source: "simplify", sourceExternalId: "s-6" }],
  };
  const repo = fakeRepo([ghRow]);
  assert.equal(await retireAliasCarriers([{ source: "greenhouse", sourceExternalId: "gh-11" }], repo), 0);
  assert.deepEqual(repo.retirements, []);
});

test("retire: a same-source dup-key entry is a suppressed sibling, never an alias", async () => {
  // A GH canonical that string-key-suppressed req-2 holds {greenhouse, req-2} in its
  // duplicateKeys. Even if req-2's key were ever persisted, that entry must not read as an
  // alias — retiring the canonical over it would delist a legitimately distinct row.
  const ghCanonical: ExistingCanonical = {
    source: "greenhouse",
    sourceExternalId: "req-1",
    company: "Meridial",
    title: "AI Training Generalist (No Prior Experience Needed)",
    location: "United States of America",
    duplicateKeys: [{ source: "greenhouse", sourceExternalId: "req-2" }],
  };
  const repo = fakeRepo([ghCanonical]);
  assert.equal(
    await retireAliasCarriers([{ source: "greenhouse", sourceExternalId: "req-2" }], repo),
    0,
  );
  assert.deepEqual(repo.retirements, []);
});
