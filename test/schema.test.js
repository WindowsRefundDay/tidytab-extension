import test from "node:test";
import assert from "node:assert/strict";

import { extractJsonObject, normalizeColor, validateSortPlan } from "../lib/schema.js";

const tabs = [
  { id: 1, title: "One" },
  { id: 2, title: "Two" },
  { id: 3, title: "Three" }
];

test("extractJsonObject parses plain and fenced JSON", () => {
  assert.deepEqual(extractJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
});

test("normalizeColor falls back to palette", () => {
  assert.equal(normalizeColor("blue", 0), "blue");
  assert.equal(normalizeColor("not-real", 1), "green");
});

test("validateSortPlan sanitizes duplicates and appends missing tabs", () => {
  const validation = validateSortPlan(
    {
      groups: [{ name: "  Work   Stuff  ", color: "blue", tabIds: [2, 2, 99], confidence: 0.8 }],
      ungroupedTabIds: [],
      warnings: ["ok"]
    },
    tabs
  );

  assert.equal(validation.ok, true);
  assert.equal(validation.plan.groups[0].name, "Work Stuff");
  assert.deepEqual(validation.plan.groups[0].tabIds, [2]);
  assert.deepEqual(validation.plan.ungroupedTabIds, [1, 3]);
});

test("validateSortPlan rejects low-confidence AI output", () => {
  const validation = validateSortPlan(
    {
      groups: [{ name: "Guess", color: "blue", tabIds: [1], confidence: 0.2 }],
      ungroupedTabIds: [2, 3],
      warnings: []
    },
    tabs
  );

  assert.equal(validation.ok, false);
  assert.match(validation.reason, /too low/);
});

test("validateSortPlan rejects missing groups", () => {
  const validation = validateSortPlan({ warnings: [] }, tabs);
  assert.equal(validation.ok, false);
});
