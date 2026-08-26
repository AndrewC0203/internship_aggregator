import { test } from "node:test";
import assert from "node:assert/strict";
import { dedup } from "./dedup.js";
import type { DedupRepo, DedupKeyParts, ExistingCanonical } from "./dedup.js";
import type { NormalizedListing, ListingKey } from "../types.js";

// A fake DedupRepo backed by a plain in-memory array — no Postgres needed, same "unit tests
// don't touch the DB" bar as filter.test.ts. `active` models the current state of `listings`
// (only ACTIVE rows matter to dedup, which is exactly what the real prismaDedupRepo filters
// to with `isListed: true`).
function fakeRepo(active: ExistingCanonical[]): DedupRepo & { merges: Array<[ListingKey, ListingKey[]]> } {
  const merges: Array<[ListingKey, ListingKey[]]> = [];
  return {
    merges,
    async findActiveByKeys(keys: DedupKeyParts[]) {
      const wanted = new Set(keys.map((k) => `${k.company}::${k.title}::${k.location ?? ""}`));
      return active.filter((a) => wanted.has(`${a.company}::${a.title}::${a.location ?? ""}`));
    },
    async mergeDuplicateKeys(target, keysToAdd) {
      merges.push([target, keysToAdd]);
      const row = active.find(
        (a) => a.source === target.source && a.sourceExternalId === target.sourceExternalId,
      );
      if (row) {
        const byKey = new Map(row.duplicateKeys.map((k) => [`${k.source}::${k.sourceExternalId}`, k]));
        for (const k of keysToAdd) byKey.set(`${k.source}::${k.sourceExternalId}`, k);
        row.duplicateKeys = [...byKey.values()];
      }
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
