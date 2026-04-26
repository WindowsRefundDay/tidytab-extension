import test from "node:test";
import assert from "node:assert/strict";

import {
  SORT_MODES,
  aiSortPlan,
  createAgenticFinalizePrompt,
  createSmartSortPrompt,
  getDomain,
  planOrFallback,
  titleSortPlan
} from "../lib/sorters.js";

const tabs = [
  { id: 3, title: "Docs - API", url: "https://docs.example.com/api" },
  { id: 1, title: "Mail", url: "https://mail.example.com/inbox" },
  { id: 2, title: "Example Home", url: "https://example.com" }
];

test("getDomain normalizes URLs", () => {
  assert.equal(getDomain("https://www.example.com/path"), "example.com");
  assert.equal(getDomain("chrome://extensions"), "Browser Pages");
  assert.equal(getDomain("not a url"), "Untitled");
});

test("titleSortPlan groups by domain and sorts titles", () => {
  const plan = titleSortPlan(tabs);
  assert.deepEqual(
    plan.groups.map((group) => group.name),
    ["docs.example.com", "example.com", "mail.example.com"]
  );
  assert.deepEqual(plan.groups.flatMap((group) => group.tabIds), [3, 2, 1]);
  assert.deepEqual(plan.ungroupedTabIds, []);
});

test("smart prompt includes tab IDs and snippets", () => {
  const prompt = createSmartSortPrompt([{ ...tabs[0], snippet: "API reference content" }]);
  assert.match(prompt, /"id": 3/);
  assert.match(prompt, /API reference content/);
});

test("smart prompt includes history context when present", () => {
  const prompt = createSmartSortPrompt([
    {
      ...tabs[0],
      history: {
        visitCount: 4,
        typedCount: 1,
        recentVisits: [{ transition: "link", referringVisitId: "2" }]
      }
    }
  ]);

  assert.match(prompt, /"history"/);
  assert.match(prompt, /"visitCount": 4/);
  assert.match(prompt, /trace-first/);
  assert.match(prompt, /Do not group pages just because they share the same domain/);
});

test("agentic finalize prompt includes draft plan", () => {
  const prompt = createAgenticFinalizePrompt(tabs, { groups: [{ name: "Work" }] });
  assert.match(prompt, /Draft grouping/);
  assert.match(prompt, /Work/);
});

test("aiSortPlan validates smart provider output", async () => {
  const validation = await aiSortPlan(tabs, SORT_MODES.SMART, async () => ({
    groups: [{ name: "Example", color: "blue", tabIds: [1, 2, 3], confidence: 0.9 }],
    ungroupedTabIds: [],
    warnings: []
  }));

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.plan.groups[0].tabIds, [1, 2, 3]);
});

test("aiSortPlan uses two provider calls for agentic mode", async () => {
  const phases = [];
  const validation = await aiSortPlan(tabs, SORT_MODES.AGENTIC, async (_prompt, meta) => {
    phases.push(meta.phase);
    return {
      groups: [{ name: "Research", color: "green", tabIds: [3, 2], confidence: 0.8 }],
      ungroupedTabIds: [1],
      warnings: []
    };
  });

  assert.deepEqual(phases, ["agentic-discovery", "agentic-finalize"]);
  assert.equal(validation.ok, true);
});

test("planOrFallback returns deterministic plan when validation fails", () => {
  const plan = planOrFallback({ ok: false, reason: "bad JSON" }, tabs);
  assert.equal(plan.groups.length, 3);
  assert.match(plan.warnings[0], /bad JSON/);
});
