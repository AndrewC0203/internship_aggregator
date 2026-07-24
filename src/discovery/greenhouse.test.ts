import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGreenhouseToken, extractGreenhouseTokens } from "./greenhouse.js";

// The slug parser is the one piece of discovery with real branching (path forms, embed
// form, reserved segments), so it's the piece worth unit-testing. Pure function, no I/O.

test("extracts token from a plain board URL", () => {
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/gitlab"), "gitlab");
});

test("extracts token from the current job-boards host", () => {
  assert.equal(extractGreenhouseToken("https://job-boards.greenhouse.io/gitlab"), "gitlab");
});

test("strips a /jobs/{id} suffix down to the token", () => {
  assert.equal(
    extractGreenhouseToken("https://boards.greenhouse.io/0x/jobs/4923909002"),
    "0x",
  );
});

test("lowercases the token so dedupe is case-insensitive", () => {
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/GitLab"), "gitlab");
});

test("pulls the token from the embed form's `for` query param", () => {
  assert.equal(
    extractGreenhouseToken("https://boards.greenhouse.io/embed/job_board?for=stripe"),
    "stripe",
  );
});

test("returns null for the host root (no token segment)", () => {
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/"), null);
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io"), null);
});

test("returns null for reserved first segments", () => {
  assert.equal(extractGreenhouseToken("https://boards.greenhouse.io/embed/job_board"), null);
});

test("returns null for a non-greenhouse host", () => {
  assert.equal(extractGreenhouseToken("https://example.com/gitlab"), null);
});

test("returns null for a malformed URL instead of throwing", () => {
  assert.equal(extractGreenhouseToken("not a url"), null);
});

test("extractGreenhouseTokens dedupes and drops nulls across a mixed list", () => {
  const urls = [
    "https://boards.greenhouse.io/gitlab",
    "https://boards.greenhouse.io/gitlab/jobs/123",
    "https://job-boards.greenhouse.io/GitLab",
    "https://boards.greenhouse.io/stripe",
    "https://boards.greenhouse.io/",
    "https://boards.greenhouse.io/embed/job_board?for=stripe",
    "garbage",
  ];
  const tokens = extractGreenhouseTokens(urls).sort();
  assert.deepEqual(tokens, ["gitlab", "stripe"]);
});
