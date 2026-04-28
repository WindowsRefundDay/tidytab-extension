import { loadSettings } from "./lib/settings.js";
import { callAiProvider } from "./lib/providers.js";
import { enrichTabsWithHistory } from "./lib/historyContext.js";
import { createUndoSnapshot, groupRestorePlan, LAST_SORT_SNAPSHOT_KEY } from "./lib/undo.js";
import { SORT_MODES, aiSortPlan, planOrFallback, titleSortPlan } from "./lib/sorters.js";

const PAGE_PERMISSION = { origins: ["<all_urls>"] };
const BATTERY_ALARM = "battery-saver-check";

chrome.runtime.onInstalled.addListener(() => {
  scheduleBatterySaverAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleBatterySaverAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== BATTERY_ALARM) return;
  runBatterySaverPass().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  if (message?.type === "GET_TAB_COUNT") {
    const tabs = await chrome.tabs.query({});
    return { count: tabs.length };
  }

  if (message?.type === "PREPARE_SORT_INPUT") {
    return prepareSortInput(message.payload || {});
  }

  if (message?.type === "APPLY_SORT_PLAN") {
    return applyPreparedSortPlan(message.payload || {});
  }

  if (message?.type === "UNDO_LAST_SORT") {
    return undoLastSort();
  }

  if (message?.type === "SORT_TABS") {
    return sortTabs(message.payload || {});
  }

  if (message?.type === "SLEEP_GROUPS_NOW") {
    return runBatterySaverPass({ force: true });
  }

  throw new Error("Unknown message.");
}

async function sortTabs(payload) {
  const settings = await loadSettings();
  const mode = payload.mode || SORT_MODES.TITLE;
  const prepared = await prepareSortInput({
    mode,
    contextMode: payload.contextMode || settings.contextMode,
    maxSnippetLength: settings.maxSnippetLength
  });
  const candidates = prepared.tabs;

  if (candidates.length === 0) {
    return { message: "No movable tabs found in this window.", moved: 0, warnings: [] };
  }

  let plan;
  if (mode === SORT_MODES.TITLE) {
    plan = titleSortPlan(candidates);
  } else {
    const validation = await aiSortPlan(candidates, mode, (prompt) => callAiProvider(settings, prompt));
    plan = planOrFallback(validation, candidates);
  }

  plan.warnings.push(...prepared.warnings);
  return applyPreparedSortPlan({ plan });
}

async function prepareSortInput(payload) {
  const settings = await loadSettings();
  const mode = payload.mode || SORT_MODES.TITLE;
  const contextMode = payload.contextMode || settings.contextMode;
  const maxSnippetLength = payload.maxSnippetLength || settings.maxSnippetLength;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs.filter((tab) => Number.isFinite(tab.id) && !tab.pinned);
  const pinnedCount = tabs.length - candidates.length;
  const warnings = [];

  if (pinnedCount) {
    warnings.push(`${pinnedCount} pinned tab${pinnedCount === 1 ? " was" : "s were"} left in place.`);
  }

  const preparedTabs =
    contextMode === "page" && mode !== SORT_MODES.TITLE
      ? await withPageSnippets(candidates, maxSnippetLength, warnings)
      : candidates;
  const historyResult =
    mode !== SORT_MODES.TITLE
      ? await enrichTabsWithHistory(preparedTabs, settings, chrome)
      : { tabs: preparedTabs, warnings: [] };
  warnings.push(...historyResult.warnings);

  return {
    tabs: historyResult.tabs.map(serializableTab),
    warnings
  };
}

async function applyPreparedSortPlan(payload) {
  const plan = payload.plan;
  if (!plan?.groups || !Array.isArray(plan.groups)) {
    throw new Error("No tab sort plan was provided.");
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const allowedTabIds = new Set(tabs.filter((tab) => Number.isFinite(tab.id) && !tab.pinned).map((tab) => tab.id));
  await saveUndoSnapshot(tabs);
  const moved = await applySortPlan(plan, allowedTabIds);
  return {
    message: `Sorted ${moved} tab${moved === 1 ? "" : "s"} into ${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"}.`,
    moved,
    groups: plan.groups.length,
    warnings: plan.warnings || []
  };
}

function serializableTab(tab) {
  return {
    id: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    openerTabId: tab.openerTabId,
    snippet: tab.snippet || "",
    history: tab.history || undefined
  };
}

async function saveUndoSnapshot(tabs) {
  const groupIds = [...new Set(tabs.map((tab) => tab.groupId).filter((id) => Number.isFinite(id) && id >= 0))];
  const groups = [];
  for (const groupId of groupIds) {
    try {
      groups.push(await chrome.tabGroups.get(groupId));
    } catch {
      // Groups can disappear while tabs are changing; undo remains best-effort.
    }
  }
  await chrome.storage.local.set({ [LAST_SORT_SNAPSHOT_KEY]: createUndoSnapshot(tabs, groups) });
}

async function undoLastSort() {
  const result = await chrome.storage.local.get(LAST_SORT_SNAPSHOT_KEY);
  const snapshot = result[LAST_SORT_SNAPSHOT_KEY];
  if (!snapshot?.tabs?.length) {
    return { message: "No sort snapshot is available to undo.", restored: 0, warnings: [] };
  }

  const currentTabs = await chrome.tabs.query({ windowId: snapshot.windowId });
  const plan = groupRestorePlan(snapshot, currentTabs);
  const warnings = [];

  if (!plan.orderedTabIds.length) {
    await chrome.storage.local.remove(LAST_SORT_SNAPSHOT_KEY);
    return { message: "No original tabs are still open to restore.", restored: 0, warnings: [] };
  }

  for (const tab of plan.restoreTabs) {
    await chrome.tabs.update(tab.id, { pinned: tab.pinned }).catch(() => {});
  }

  const pinnedIds = plan.restoreTabs.filter((tab) => tab.pinned).map((tab) => tab.id);
  const unpinnedIds = plan.restoreTabs.filter((tab) => !tab.pinned).map((tab) => tab.id);
  if (pinnedIds.length) {
    await chrome.tabs.move(pinnedIds, { index: 0 });
  }
  if (unpinnedIds.length) {
    await chrome.tabs.move(unpinnedIds, { index: pinnedIds.length });
  }

  if (plan.ungroupedTabIds.length) {
    await chrome.tabs.ungroup(plan.ungroupedTabIds).catch(() => {});
  }

  for (const group of plan.groups) {
    const groupId = await chrome.tabs.group({ tabIds: group.tabIds });
    await chrome.tabGroups.update(groupId, {
      title: group.metadata.title,
      color: group.metadata.color,
      collapsed: group.metadata.collapsed
    });
  }

  if (plan.missingTabIds.length) {
    warnings.push(`${plan.missingTabIds.length} closed tab${plan.missingTabIds.length === 1 ? " was" : "s were"} skipped.`);
  }

  await chrome.storage.local.remove(LAST_SORT_SNAPSHOT_KEY);
  return {
    message: `Restored ${plan.orderedTabIds.length} tab${plan.orderedTabIds.length === 1 ? "" : "s"} from the last sort.`,
    restored: plan.orderedTabIds.length,
    warnings
  };
}

async function withPageSnippets(tabs, maxSnippetLength, warnings) {
  const hasPermission = await chrome.permissions.contains(PAGE_PERMISSION);
  if (!hasPermission) {
    warnings.push("Page snippets require optional site access; used titles and URLs only.");
    return tabs;
  }

  const enriched = [];
  for (const tab of tabs) {
    if (!/^https?:\/\//i.test(tab.url || "")) {
      enriched.push(tab);
      continue;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-extractor.js"]
      });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (limit) => window.__aiTabSorterExtract?.(limit) || "",
        args: [maxSnippetLength]
      });
      enriched.push({ ...tab, snippet: result?.result || "" });
    } catch {
      warnings.push(`Could not inspect "${tab.title || tab.url}".`);
      enriched.push(tab);
    }
  }

  return enriched;
}

async function applySortPlan(plan, allowedTabIds) {
  let index = 0;
  let moved = 0;

  for (const group of plan.groups) {
    const tabIds = group.tabIds.filter((id) => allowedTabIds.has(id));
    if (!tabIds.length) continue;

    await chrome.tabs.move(tabIds, { index });
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: group.name,
      color: group.color,
      collapsed: false
    });
    await chrome.tabGroups.move(groupId, { index });
    index += tabIds.length;
    moved += tabIds.length;
  }

  const ungrouped = plan.ungroupedTabIds.filter((id) => allowedTabIds.has(id));
  if (ungrouped.length) {
    await chrome.tabs.ungroup(ungrouped).catch(() => {});
    await chrome.tabs.move(ungrouped, { index });
    moved += ungrouped.length;
  }

  return moved;
}


async function scheduleBatterySaverAlarm() {
  await chrome.alarms.create(BATTERY_ALARM, { periodInMinutes: 5 });
}

async function runBatterySaverPass(options = {}) {
  const settings = await loadSettings();
  if (!settings.batterySaverEnabled && !options.force) {
    return { message: "Battery saver is disabled.", sleptTabs: 0, groups: 0 };
  }

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const profile = resolveLimiterProfile(settings.limiterProfile);
  const startMs = (settings.limiterEnabled ? settings.limiterStartMinutes : settings.batterySaverAutoSleepMinutes) * 60_000;
  const sleepMs = (settings.limiterEnabled ? settings.limiterSleepMinutes : settings.batterySaverAutoSleepMinutes) * 60_000;
  const candidates = [];

  for (const tab of tabs) {
    if (!Number.isFinite(tab.id) || tab.pinned || tab.active || tab.discarded) continue;
    if (tab.groupId == null || tab.groupId < 0) continue;
    if (tab.audible && !settings.batterySaverDiscardAudioTabs) continue;

    const inactiveMs = Math.max(0, now - (tab.lastAccessed || 0));
    if (!options.force && inactiveMs < startMs) continue;

    const pressure = Math.min(1, inactiveMs / Math.max(startMs, 1));
    const score = pressure * profile.multiplier;

    if (settings.limiterEnabled && inactiveMs >= startMs && inactiveMs < sleepMs) {
      await chrome.tabs.update(tab.id, { autoDiscardable: true }).catch(() => {});
      if (score > 1.25) {
        await chrome.tabs.discard(tab.id).catch(() => {});
      }
      continue;
    }

    if (options.force || inactiveMs >= sleepMs || score > 1.75) {
      candidates.push(tab);
    }
  }

  for (const tab of candidates) {
    await chrome.tabs.update(tab.id, { autoDiscardable: true }).catch(() => {});
    await chrome.tabs.discard(tab.id).catch(() => {});
  }

  const groups = new Set(candidates.map((tab) => tab.groupId).filter((id) => id >= 0));
  if (settings.batterySaverCollapseGroupsAfterSleep) {
    for (const groupId of groups) {
      await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
    }
  }

  return {
    message: `Slept ${candidates.length} tab${candidates.length === 1 ? "" : "s"} across ${groups.size} group${groups.size === 1 ? "" : "s"}.`,
    sleptTabs: candidates.length,
    groups: groups.size
  };
}

function resolveLimiterProfile(value) {
  if (value === "aggressive") return { multiplier: 1.5 };
  if (value === "relaxed") return { multiplier: 0.9 };
  return { multiplier: 1.15 };
}
