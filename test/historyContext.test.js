import test from "node:test";
import assert from "node:assert/strict";

import {
  createHistorySummary,
  addTraceContext,
  enrichTabsWithHistory,
  nearbyHistoryEntries,
  normalizeHistoryUrl,
  recentVisits
} from "../lib/historyContext.js";

test("normalizeHistoryUrl keeps http URLs and removes fragments", () => {
  assert.equal(normalizeHistoryUrl("https://example.com/path#section"), "https://example.com/path");
  assert.equal(normalizeHistoryUrl("chrome://extensions"), "");
  assert.equal(normalizeHistoryUrl("not a url"), "");
});

test("recentVisits returns newest bounded visit details", () => {
  const visits = recentVisits(
    [
      { visitId: "1", visitTime: 100, transition: "typed", referringVisitId: "0", isLocal: true },
      { visitId: "2", visitTime: 300, transition: "link", referringVisitId: "1", isLocal: false },
      { visitId: "3", visitTime: 200, transition: "reload", referringVisitId: "2" }
    ],
    2
  );

  assert.deepEqual(
    visits.map((visit) => visit.visitId),
    ["2", "3"]
  );
  assert.equal(visits[0].transition, "link");
});

test("nearbyHistoryEntries returns newest bounded history items", () => {
  const nearby = nearbyHistoryEntries(
    [
      { url: "https://old.test", title: "Old", lastVisitTime: 1 },
      { url: "https://new.test", title: "New", lastVisitTime: 2, visitCount: 4, typedCount: 1 }
    ],
    1
  );

  assert.deepEqual(nearby, [
    {
      title: "New",
      url: "https://new.test",
      lastVisitTime: 2,
      visitCount: 4,
      typedCount: 1
    }
  ]);
});

test("createHistorySummary includes opener and full bounded detail", () => {
  const summary = createHistorySummary(
    { id: 2, openerTabId: 1, url: "https://example.com/page" },
    { visitCount: 5, typedCount: 2, lastVisitTime: 123 },
    [{ visitId: "10", visitTime: 123, transition: "link", referringVisitId: "9" }],
    [{ url: "https://near.test", title: "Near", lastVisitTime: 100 }],
    new Map([[1, { id: 1, title: "Source", url: "https://source.test" }]]),
    { historyMaxVisitsPerTab: 4, historyNearbyLimit: 4 }
  );

  assert.equal(summary.visitCount, 5);
  assert.equal(summary.currentVisit.visitId, "10");
  assert.equal(summary.opener.title, "Source");
  assert.equal(summary.recentVisits[0].referringVisitId, "9");
  assert.equal(summary.nearby[0].url, "https://near.test");
});

test("addTraceContext links timeline neighbors and referrer visits", () => {
  const tabs = addTraceContext([
    {
      id: 1,
      title: "Search",
      url: "https://search.test",
      history: {
        typedCount: 1,
        lastVisitTime: 100,
        currentVisit: { visitId: "v1", visitTime: 100, transition: "typed", referringVisitId: "" },
        recentVisits: [{ visitId: "v1", visitTime: 100, transition: "typed", referringVisitId: "" }]
      }
    },
    {
      id: 2,
      title: "Result",
      url: "https://result.test",
      history: {
        typedCount: 0,
        lastVisitTime: 200,
        currentVisit: { visitId: "v2", visitTime: 200, transition: "link", referringVisitId: "v1" },
        recentVisits: [{ visitId: "v2", visitTime: 200, transition: "link", referringVisitId: "v1" }]
      }
    }
  ]);

  assert.equal(tabs[0].history.trace.nextCurrentTab.tabId, 2);
  assert.equal(tabs[1].history.trace.previousCurrentTab.tabId, 1);
  assert.equal(tabs[1].history.trace.referrerCurrentTab.tabId, 1);
  assert.match(tabs[1].history.trace.sourceEvidence.join(" "), /history referrer/);
});

test("enrichTabsWithHistory returns warning when permission is missing", async () => {
  const result = await enrichTabsWithHistory(
    [{ id: 1, title: "One", url: "https://example.com" }],
    { historyContextEnabled: true },
    { permissions: { contains: async () => false } }
  );

  assert.equal(result.tabs[0].history, undefined);
  assert.match(result.warnings[0], /permission is missing/);
});

test("enrichTabsWithHistory adds history context when permission is present", async () => {
  const result = await enrichTabsWithHistory(
    [{ id: 1, title: "One", url: "https://example.com", openerTabId: 2 }, { id: 2, title: "Two", url: "https://two.test" }],
    {
      historyContextEnabled: true,
      historyLookbackHours: 24,
      historyMaxVisitsPerTab: 2,
      historyNearbyLimit: 1
    },
    {
      permissions: { contains: async () => true },
      history: {
        search: async (query) =>
          query.text
            ? [{ url: "https://example.com/", visitCount: 3, typedCount: 1, lastVisitTime: 50 }]
            : [{ url: "https://near.test", title: "Near", lastVisitTime: 60 }],
        getVisits: async () => [{ visitId: "1", visitTime: 50, transition: "link", referringVisitId: "0" }]
      }
    }
  );

  assert.equal(result.warnings.length, 0);
  assert.equal(result.tabs[0].history.visitCount, 3);
  assert.equal(result.tabs[0].history.opener.title, "Two");
});
