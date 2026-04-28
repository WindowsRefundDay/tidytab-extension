import test from "node:test";
import assert from "node:assert/strict";

import { summarizeSnippetFailures } from "../lib/warnings.js";

test("summarizeSnippetFailures returns no warnings for complete snippet coverage", () => {
  assert.deepEqual(summarizeSnippetFailures([]), []);
});

test("summarizeSnippetFailures collapses per-tab snippet failures", () => {
  const warnings = summarizeSnippetFailures([
    { title: "GitHub" },
    { title: "Canvas" },
    { title: "RapidIdentity" },
    { title: "YouTube" },
    { title: "Gemini" }
  ]);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /5 tabs/);
  assert.match(warnings[0], /used title, URL, and history context instead/);
  assert.match(warnings[0], /and 1 more/);
});
