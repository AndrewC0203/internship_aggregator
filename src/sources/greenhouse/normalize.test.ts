import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGreenhouse } from "./normalize.js";

// Regression tests for the entity-decode ordering bug (found 2026-08-08 on the first real
// end-to-end run). Greenhouse ships `content` entity-ENCODED — the raw string contains
// "&lt;p&gt;", not "<p>". htmlToPlain() strips tags FIRST and decodes entities LAST, so
// passing it the raw string matched no tags: it decoded them INTO markup instead of removing
// it, and descriptionPlain was stored full of literal <div>/<a href> tags.
//
// That fed the classifier markup instead of prose and inflated the text ~22% on a real
// posting — which matters more than it sounds, because the model call is prefill-bound and
// 68% of postings hit the MAX_DESC_CHARS ceiling, so the padding was truncating real job
// requirements off the end.

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/gitlab.jobs.sample.json", import.meta.url), "utf8"),
) as { jobs: Array<Record<string, unknown>> };

const TAG = /<[a-z][^>]*>/i;

test("fixture really is entity-encoded (guards the premise of these tests)", () => {
  // If Greenhouse ever ships decoded HTML, this fails and the tests below stop being
  // meaningful — better to find out here than to have them silently pass.
  for (const job of fixture.jobs) {
    assert.match(String(job.content), /&lt;|&gt;|&quot;/);
  }
});

test("descriptionPlain contains NO html tags — the regression", () => {
  for (const job of fixture.jobs) {
    const out = normalizeGreenhouse(job, {});
    assert.ok(out, "fixture jobs all have company_name, so none should be dropped");
    assert.doesNotMatch(
      out.descriptionPlain,
      TAG,
      `descriptionPlain still contains markup for "${out.title}"`,
    );
  }
});

test("descriptionPlain contains no leftover encoded entities either", () => {
  for (const job of fixture.jobs) {
    const out = normalizeGreenhouse(job, {})!;
    assert.doesNotMatch(out.descriptionPlain, /&lt;|&gt;|&quot;|&amp;/);
  }
});

test("descriptionHtml keeps its markup (display path is unaffected)", () => {
  for (const job of fixture.jobs) {
    const out = normalizeGreenhouse(job, {})!;
    assert.match(out.descriptionHtml, TAG, "descriptionHtml should still be real HTML");
  }
});

test("plain text is materially shorter than the html it came from", () => {
  // The bug's tell: descriptionPlain was ~the same length as descriptionHtml because the
  // markup was never removed. Stripping tags must actually shrink it.
  for (const job of fixture.jobs) {
    const out = normalizeGreenhouse(job, {})!;
    assert.ok(
      out.descriptionPlain.length < out.descriptionHtml.length,
      `plain (${out.descriptionPlain.length}) should be shorter than html ` +
        `(${out.descriptionHtml.length}) for "${out.title}"`,
    );
  }
});

test("plain text starts with prose, not a tag", () => {
  const out = normalizeGreenhouse(fixture.jobs[0], {})!;
  assert.doesNotMatch(out.descriptionPlain.slice(0, 40), /[<>]/);
});

test("drops a job with no company_name rather than guessing one", () => {
  const job = { ...fixture.jobs[0], company_name: "  " };
  assert.equal(normalizeGreenhouse(job, {}), null);
});
