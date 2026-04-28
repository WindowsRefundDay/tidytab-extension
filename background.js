import { loadSettings } from "./lib/settings.js";
import { callAiProvider } from "./lib/providers.js";
import { enrichTabsWithHistory } from "./lib/historyContext.js";
import { createUndoSnapshot, groupRestorePlan, LAST_SORT_SNAPSHOT_KEY } from "./lib/undo.js";
import { SORT_MODES, aiSortPlan, planOrFallback, titleSortPlan } from "./lib/sorters.js";
import { summarizeSnippetFailures } from "./lib/warnings.js";

const PAGE_PERMISSION = { origins: ["<all_urls>"] };
const SORT_STATUS_KEY = "aiTabSorterSortStatus";
const PAGE_SNIPPET_TIMEOUT_MS = 2500;
const BATTERY_ALARM = "battery-saver-check";

let activeSortPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  syncActionPopup().catch(() => {});
  scheduleBatterySaverAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  syncActionPopup().catch(() => {});
  scheduleBatterySaverAlarm().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.aiTabSorterSettings) {
    syncActionPopup().catch(() => {});
  }
});

chrome.action.onClicked.addListener(() => {
  sortFromActionClick().catch((error) => {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setTitle({ title: `TidyTab sort failed: ${error.message || String(error)}` });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "TidyTab" });
    }, 5000);
  });
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

  if (message?.type === "GET_SORT_STATUS") {
    return { status: await getSortStatus() };
  }

  if (message?.type === "CLEAR_SORT_STATUS") {
    await clearSortStatus();
    return { status: await getSortStatus() };
  }

  if (message?.type === "START_SORT_PROCESS") {
    return startPersistentSort();
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

async function getSortStatus() {
  const result = await chrome.storage.local.get(SORT_STATUS_KEY);
  return (
    result[SORT_STATUS_KEY] || {
      running: false,
      message: "",
      className: "",
      steps: []
    }
  );
}

async function setSortStatus(patch) {
  const current = await getSortStatus();
  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [SORT_STATUS_KEY]: next });
  return next;
}

async function clearSortStatus() {
  await chrome.storage.local.remove(SORT_STATUS_KEY);
}

async function addSortStep(message, className = "") {
  const current = await getSortStatus();
  const steps = (current.steps || []).map((step, index, list) => ({
    ...step,
    state: index === list.length - 1 && step.state === "active" ? "complete" : step.state
  }));
  steps.push({
    id: `${Date.now()}-${steps.length}`,
    message,
    className,
    state: className === "error" ? "active" : "active"
  });
  return setSortStatus({ steps });
}

async function startPersistentSort() {
  if (activeSortPromise) {
    await activeSortPromise;
    return { status: await getSortStatus() };
  }

  await setSortStatus({
    running: true,
    message: "Sorting tabs...",
    className: "",
    steps: []
  });

  activeSortPromise = runPersistentSort()
    .catch(() => {})
    .finally(() => {
      activeSortPromise = null;
    });

  await activeSortPromise;
  return { status: await getSortStatus() };
}

async function runPersistentSort() {
  try {
    await addSortStep("Loading saved sorting preferences.");
    const settings = await loadSettings();
    await addSortStep(`Provider ready: ${providerLabel(settings.provider)}.`);

    if (settings.contextMode === "page" && settings.sortMode !== SORT_MODES.TITLE) {
      await addSortStep("Using granted page access for snippets.");
    }

    if (settings.sortMode !== SORT_MODES.TITLE) {
      await addSortStep(settings.historyContextEnabled ? "History signal is enabled." : "History signal is off.");
    }

    const mode =
      settings.provider === "chromeBuiltIn" && settings.sortMode !== SORT_MODES.TITLE
        ? SORT_MODES.TITLE
        : settings.sortMode || SORT_MODES.TITLE;
    if (mode !== settings.sortMode) {
      await addSortStep("Chrome Built-in AI needs the popup open; using title sort for background sorting.");
    }

    await addSortStep("Preparing current-window tabs.");
    await setSortStatus({ message: "Preparing current-window tabs...", className: "" });
    const prepared = await prepareSortInput({
      mode,
      contextMode: settings.contextMode,
      maxSnippetLength: settings.maxSnippetLength
    });

    if (!prepared.tabs.length) {
      await setSortStatus({
        running: false,
        message: "No movable tabs found in this window.",
        className: "success"
      });
      return;
    }

    await describePersistentPreparedInput(prepared);

    let plan;
    let statusClass = "success";
    if (mode === SORT_MODES.TITLE) {
      await addSortStep("Sorting by title and domain.");
      plan = titleSortPlan(prepared.tabs);
    } else {
      await addSortStep("Sending structured sort request to the selected AI provider.");
      const validation = await aiSortPlan(prepared.tabs, mode, async (prompt, meta) => {
        await announcePersistentAiPhase(providerLabel(settings.provider), meta.phase);
        return callAiProvider(settings, prompt);
      });
      await addPersistentValidationActivity(validation);
      plan = planOrFallback(validation, prepared.tabs);
      statusClass = validation.ok ? "success" : "";
    }

    plan.warnings.push(...prepared.warnings);
    await describePersistentPlan(plan);
    await addSortStep("Applying tab moves and groups.");
    const applied = await applyPreparedSortPlan({ plan });
    const suffix = applied.warnings?.length ? ` ${applied.warnings.join(" ")}` : "";
    await setSortStatus({
      running: false,
      message: `${applied.message}${suffix}`,
      className: statusClass
    });
  } catch (error) {
    await addSortStep(error.message || String(error), "error");
    await setSortStatus({
      running: false,
      message: error.message || String(error),
      className: "error"
    });
  }
}

function providerLabel(value) {
  if (value === "openai") return "OpenAI";
  if (value === "compatible") return "OpenAI-compatible";
  if (value === "vertex") return "Google Vertex AI";
  if (value === "gemini") return "Gemini API key";
  if (value === "chromeBuiltIn") return "Chrome Built-in AI";
  return value;
}

async function describePersistentPreparedInput(prepared) {
  const tabs = prepared.tabs || [];
  const snippetCount = tabs.filter((tab) => tab.snippet).length;
  const historyCount = tabs.filter((tab) => tab.history).length;
  await addSortStep(`Prepared ${tabs.length} movable tab${tabs.length === 1 ? "" : "s"}.`);
  if (snippetCount) await addSortStep(`Included page snippets for ${snippetCount} tab${snippetCount === 1 ? "" : "s"}.`);
  if (historyCount) await addSortStep(`Included history signal for ${historyCount} tab${historyCount === 1 ? "" : "s"}.`);
  for (const warning of prepared.warnings || []) {
    await addSortStep(`Warning: ${warning}`);
  }
}

async function announcePersistentAiPhase(provider, phase) {
  if (phase === "agentic-discovery") {
    await setSortStatus({ message: `${provider} is drafting workflow groups...`, className: "" });
    await addSortStep("AI phase 1: infer workflows and candidate groups.");
  } else if (phase === "agentic-finalize") {
    await setSortStatus({ message: `${provider} is refining groups...`, className: "" });
    await addSortStep("AI phase 2: normalize groups, sequence tabs, and check coverage.");
  } else {
    await setSortStatus({ message: `${provider} is sorting tabs...`, className: "" });
    await addSortStep("AI phase: infer groups and order.");
  }
}

async function addPersistentValidationActivity(validation) {
  if (validation.ok) {
    await addSortStep(`Validated AI plan with ${validation.plan.groups.length} group${validation.plan.groups.length === 1 ? "" : "s"}.`);
  } else {
    await addSortStep(`AI plan failed validation: ${validation.reason || "unknown reason"}.`);
    await addSortStep("Fallback: using deterministic title/domain sort.");
  }
}

async function describePersistentPlan(plan) {
  const names = plan.groups.map((group) => `${group.name} (${group.tabIds.length})`).join(", ");
  await addSortStep(`Final plan: ${names || "no groups"}.`);
}

async function syncActionPopup() {
  const settings = await loadSettings();
  await chrome.action.setPopup({ popup: settings.sortOnActionClick ? "" : "popup.html" });
  await chrome.action.setTitle({
    title: settings.sortOnActionClick ? "TidyTab: click to sort current window" : "TidyTab"
  });
}

async function sortFromActionClick() {
  const settings = await loadSettings();
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  await chrome.action.setBadgeText({ text: "..." });

  try {
    const mode =
      settings.provider === "chromeBuiltIn" && settings.sortMode !== SORT_MODES.TITLE
        ? SORT_MODES.TITLE
        : settings.sortMode || SORT_MODES.AGENTIC;
    await sortTabs({
      mode,
      contextMode: settings.contextMode
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#067647" });
    await chrome.action.setBadgeText({ text: "OK" });
  } finally {
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
  }
}

async function sortTabs(payload) {
  const settings = await loadSettings();
  const mode = payload.mode || settings.sortMode || SORT_MODES.TITLE;
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
  const snippetFailures = [];
  for (const tab of tabs) {
    if (!/^https?:\/\//i.test(tab.url || "")) {
      enriched.push(tab);
      continue;
    }

    try {
      await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content-extractor.js"]
        }),
        PAGE_SNIPPET_TIMEOUT_MS,
        "snippet injector timed out"
      );
      const [result] = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (limit) => window.__aiTabSorterExtract?.(limit) || "",
          args: [maxSnippetLength]
        }),
        PAGE_SNIPPET_TIMEOUT_MS,
        "snippet extraction timed out"
      );
      enriched.push({ ...tab, snippet: result?.result || "" });
    } catch (error) {
      snippetFailures.push({
        title: tab.title || "",
        url: tab.url || "",
        reason: error.message || String(error)
      });
      enriched.push(tab);
    }
  }

  warnings.push(...summarizeSnippetFailures(snippetFailures));
  return enriched;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
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
