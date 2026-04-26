export function normalizeHistoryUrl(url) {
  try {
    const parsed = new URL(url || "");
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function recentVisits(visits, maxVisits) {
  return [...(visits || [])]
    .filter((visit) => Number.isFinite(visit.visitTime))
    .sort((a, b) => b.visitTime - a.visitTime)
    .slice(0, maxVisits)
    .map((visit) => ({
      visitId: String(visit.visitId || ""),
      referringVisitId: String(visit.referringVisitId || ""),
      visitTime: visit.visitTime,
      transition: visit.transition || "unknown",
      isLocal: visit.isLocal ?? undefined
    }));
}

export function nearbyHistoryEntries(entries, maxEntries) {
  return [...(entries || [])]
    .filter((entry) => entry?.url)
    .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))
    .slice(0, maxEntries)
    .map((entry) => ({
      title: entry.title || "",
      url: entry.url || "",
      lastVisitTime: entry.lastVisitTime || 0,
      visitCount: entry.visitCount || 0,
      typedCount: entry.typedCount || 0
    }));
}

export function createHistorySummary(tab, historyItem, visits, nearbyEntries, openTabsById, limits) {
  const opener = Number.isFinite(tab.openerTabId) ? openTabsById.get(tab.openerTabId) : null;
  const visitsRecentFirst = recentVisits(visits, limits.historyMaxVisitsPerTab);
  return {
    url: normalizeHistoryUrl(tab.url),
    visitCount: historyItem?.visitCount || 0,
    typedCount: historyItem?.typedCount || 0,
    lastVisitTime: historyItem?.lastVisitTime || null,
    currentVisit: visitsRecentFirst[0] || null,
    recentVisits: visitsRecentFirst,
    opener: opener
      ? {
          tabId: opener.id,
          title: opener.title || "",
          url: opener.url || ""
        }
      : null,
    nearby: nearbyHistoryEntries(nearbyEntries, limits.historyNearbyLimit)
  };
}

export function addTraceContext(tabs) {
  const visitIndex = new Map();
  for (const tab of tabs) {
    for (const visit of tab.history?.recentVisits || []) {
      if (visit.visitId) {
        visitIndex.set(visit.visitId, { tabId: tab.id, title: tab.title || "", url: tab.url || "", visit });
      }
    }
  }

  const timeline = tabs
    .filter((tab) => Number.isFinite(tab.history?.lastVisitTime))
    .sort((a, b) => a.history.lastVisitTime - b.history.lastVisitTime);
  const timelineIndex = new Map(timeline.map((tab, index) => [tab.id, index]));

  return tabs.map((tab) => {
    if (!tab.history) return tab;

    const index = timelineIndex.get(tab.id);
    const previous = Number.isFinite(index) ? timeline[index - 1] : null;
    const next = Number.isFinite(index) ? timeline[index + 1] : null;
    const currentVisit = tab.history.currentVisit || tab.history.recentVisits?.[0] || null;
    const referrer = currentVisit?.referringVisitId ? visitIndex.get(currentVisit.referringVisitId) : null;

    const sourceEvidence = [];
    if (tab.history.opener) {
      sourceEvidence.push(`opened from current tab ${tab.history.opener.tabId}: ${tab.history.opener.title || tab.history.opener.url}`);
    }
    if (referrer) {
      sourceEvidence.push(`history referrer appears to be tab ${referrer.tabId}: ${referrer.title || referrer.url}`);
    }
    if (currentVisit?.transition) {
      sourceEvidence.push(`latest transition: ${currentVisit.transition}`);
    }
    if (tab.history.typedCount > 0) {
      sourceEvidence.push("user has typed this URL before");
    }

    return {
      ...tab,
      history: {
        ...tab.history,
        trace: {
          timelineRank: Number.isFinite(index) ? index + 1 : null,
          previousCurrentTab: previous ? traceNeighbor(previous) : null,
          nextCurrentTab: next ? traceNeighbor(next) : null,
          referrerCurrentTab: referrer ? traceNeighbor(referrer) : null,
          sourceEvidence
        }
      }
    };
  });
}

function traceNeighbor(tab) {
  return {
    tabId: tab.tabId || tab.id,
    title: tab.title || "",
    url: tab.url || "",
    visitTime: tab.visit?.visitTime || tab.history?.lastVisitTime || null
  };
}

export async function enrichTabsWithHistory(tabs, settings, chromeApi = globalThis.chrome) {
  const warnings = [];
  const historyContextEnabled = Boolean(settings.historyContextEnabled);
  if (!historyContextEnabled) {
    return { tabs, warnings };
  }

  const hasPermission = await chromeApi.permissions.contains({ permissions: ["history"] });
  if (!hasPermission) {
    return {
      tabs,
      warnings: ["History context is enabled but history permission is missing; used non-history tab context."]
    };
  }

  const now = Date.now();
  const lookbackMs = Math.max(1, settings.historyLookbackHours || 24) * 60 * 60 * 1000;
  const startTime = now - lookbackMs;
  const nearbyLimit = settings.historyNearbyLimit || 12;
  const nearbyEntries = await chromeApi.history.search({
    text: "",
    startTime,
    endTime: now,
    maxResults: nearbyLimit
  });
  const openTabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const limits = {
    historyMaxVisitsPerTab: settings.historyMaxVisitsPerTab || 8,
    historyNearbyLimit: nearbyLimit
  };

  const enriched = [];
  for (const tab of tabs) {
    const url = normalizeHistoryUrl(tab.url);
    if (!url) {
      enriched.push(tab);
      continue;
    }

    try {
      const matches = await chromeApi.history.search({
        text: url,
        startTime: 0,
        maxResults: 1
      });
      const historyItem = matches.find((item) => normalizeHistoryUrl(item.url) === url) || matches[0] || null;
      const visits = await chromeApi.history.getVisits({ url });
      enriched.push({
        ...tab,
        history: createHistorySummary(tab, historyItem, visits, nearbyEntries, openTabsById, limits)
      });
    } catch {
      warnings.push(`Could not load history for "${tab.title || tab.url}".`);
      enriched.push(tab);
    }
  }

  return { tabs: addTraceContext(enriched), warnings };
}
