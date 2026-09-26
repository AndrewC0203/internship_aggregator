import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPreclassified } from "./preclassified.js";
import type { NormalizedListing } from "../types.js";

let n = 0;
function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "greenhouse",
    sourceExternalId: `ext-${++n}`,
    company: "Acme",
    title: "Software Engineer Intern",
    descriptionHtml: "<p>x</p>",
    descriptionPlain: "x",
    location: null,
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

const preset = {
  opportunityType: "internship" as const,
  csField: "ml_ai" as const,
  citizenshipStatus: "no_sponsorship" as const,
};

test("pre-classified listings split off; everything else flows on untouched", () => {
  const pre = listing({ source: "simplify", preclassified: preset });
  const plain = listing();

  const out = splitPreclassified([plain, pre]);

  assert.equal(out.pre.length, 1);
  assert.equal(out.pre[0].sourceExternalId, pre.sourceExternalId);
  assert.deepEqual(out.rest, [plain]);
});

test("the source's verdict becomes the enriched row; AI-extract fields stay null", () => {
  const out = splitPreclassified([listing({ source: "simplify", preclassified: preset })]);

  const enriched = out.pre[0];
  assert.equal(enriched.opportunityType, "internship");
  assert.equal(enriched.csField, "ml_ai");
  assert.equal(enriched.citizenshipStatus, "no_sponsorship");
  assert.equal(enriched.gradDateMin, null);
  assert.equal(enriched.gradDateMax, null);
  assert.equal(enriched.gradYearMin, null);
  assert.equal(enriched.gradYearMax, null);
  assert.equal(enriched.degreeStatus, null);
});

test("the preclassified marker is consumed — it must not reach persist's row spread", () => {
  const out = splitPreclassified([listing({ source: "simplify", preclassified: preset })]);
  assert.equal("preclassified" in out.pre[0], false);
});

test("an empty batch yields empty halves", () => {
  assert.deepEqual(splitPreclassified([]), { pre: [], rest: [] });
});
