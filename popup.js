import { withChromeBuiltInSession, promptChromeBuiltIn } from "./lib/chromeBuiltIn.js";
import { callAiProvider } from "./lib/providers.js";
import { loadSettings, saveSettings } from "./lib/settings.js";
import { SORT_MODES, aiSortPlan, planOrFallback, titleSortPlan } from "./lib/sorters.js";

const mode = document.querySelector("#mode");
const contextMode = document.querySelector("#contextMode");
const sortButton = document.querySelector("#sortButton");
const sleepButton = document.querySelector("#sleepButton");
const undoButton = document.querySelector("#undoButton");
const optionsButton = document.querySelector("#optionsButton");
const clearLogButton = document.querySelector("#clearLogButton");
const status = document.querySelector("#status");
const tabCount = document.querySelector("#tabCount");
const activityLog = document.querySelector("#activityLog");

init();

async function init() {
  const settings = await loadSettings();
  mode.value = settings.sortMode;
  contextMode.value = settings.contextMode;
  await refreshTabCount();

  sortButton.addEventListener("click", sortTabs);
  sleepButton.addEventListener("click", sleepGroupsNow);
  undoButton.addEventListener("click", undoSort);
  optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  clearLogButton.addEventListener("click", clearActivity);
}

async function refreshTabCount() {
  const response = await chrome.runtime.sendMessage({ type: "GET_TAB_COUNT" });
  const settings = await loadSettings();
  const historyText = settings.historyContextEnabled ? " • history-aware AI on" : "";
  tabCount.textContent = `${response.count} tab${response.count === 1 ? "" : "s"} in current window${historyText}`;
}

async function sortTabs() {
  clearActivity();
  setStatus("Sorting tabs...", "");
  addActivity(`Mode: ${modeLabel(mode.value)}. Context: ${contextMode.value === "page" ? "page snippets" : "title + URL"}.`);
  sortButton.disabled = true;

  try {
    const settings = await loadSettings();
    settings.sortMode = mode.value;
    settings.contextMode = contextMode.value;
    await saveSettings(settings);
    addActivity(`Provider: ${providerLabel(settings.provider)}.`);

    if (contextMode.value === "page" && mode.value !== "title") {
      addActivity("Requesting page access for snippet extraction.");
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
      if (!granted) {
        throw new Error("Page snippets need site access. Switch to Title + URL or grant access.");
      }
    }

    if (mode.value !== SORT_MODES.TITLE) {
      addActivity(settings.historyContextEnabled ? "History-aware context is enabled." : "History-aware context is off.");
    }

    if (settings.provider === "chromeBuiltIn" && mode.value !== SORT_MODES.TITLE) {
      await sortWithChromeBuiltIn(settings);
      return;
    }

    if (mode.value !== SORT_MODES.TITLE) {
      await sortWithCloudAi(settings);
      return;
    }

    addActivity("Using deterministic title/domain sort. No AI call is needed.");
    const response = await chrome.runtime.sendMessage({
      type: "SORT_TABS",
      payload: {
        mode: mode.value,
        contextMode: contextMode.value
      }
    });

    if (!response.ok) throw new Error(response.error);

    const suffix = response.warnings?.length ? ` ${response.warnings.join(" ")}` : "";
    setStatus(`${response.message}${suffix}`, "success");
    await refreshTabCount();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    sortButton.disabled = false;
  }
}

function setStatus(message, className) {
  status.textContent = message;
  status.className = `status ${className}`.trim();
}

function addActivity(message) {
  const item = document.createElement("li");
  item.textContent = message;
  activityLog.append(item);
  activityLog.scrollTop = activityLog.scrollHeight;
}

function clearActivity() {
  activityLog.replaceChildren();
}

function modeLabel(value) {
  if (value === SORT_MODES.TITLE) return "Title Sort";
  if (value === SORT_MODES.SMART) return "Smart AI Sort";
  if (value === SORT_MODES.AGENTIC) return "Agentic Sort";
  return value;
}

function providerLabel(value) {
  if (value === "openai") return "OpenAI";
  if (value === "compatible") return "OpenAI-compatible";
  if (value === "vertex") return "Google Vertex AI";
  if (value === "gemini") return "Gemini API key";
  if (value === "chromeBuiltIn") return "Chrome Built-in AI";
  return value;
}

async function undoSort() {
  setStatus("Restoring last sort...", "");
  addActivity("Undo requested. Restoring the last pre-sort snapshot.");
  undoButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: "UNDO_LAST_SORT" });
    if (!response.ok) throw new Error(response.error);

    const suffix = response.warnings?.length ? ` ${response.warnings.join(" ")}` : "";
    setStatus(`${response.message}${suffix}`, "success");
    await refreshTabCount();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    undoButton.disabled = false;
  }
}

async function sortWithChromeBuiltIn(settings) {
  addActivity("Preparing tab context in the background worker.");
  setStatus("Preparing current-window tabs...", "");
  const prepared = await chrome.runtime.sendMessage({
    type: "PREPARE_SORT_INPUT",
    payload: {
      mode: mode.value,
      contextMode: contextMode.value,
      maxSnippetLength: settings.maxSnippetLength
    }
  });

  if (!prepared.ok) throw new Error(prepared.error);
  if (!prepared.tabs.length) {
    setStatus("No movable tabs found in this window.", "success");
    return;
  }
  describePreparedInput(prepared);

  let plan = titleSortPlan(prepared.tabs);
  const fallbackWarnings = [];

  try {
    addActivity("Creating local Chrome Built-in AI session.");
    setStatus("Starting Chrome Built-in AI. A first-time model download may be required...", "");
    await withChromeBuiltInSession(
      async (session) => {
        const validation = await aiSortPlan(prepared.tabs, mode.value, async (prompt, meta) => {
          announceAiPhase("Chrome Built-in AI", meta.phase);
          return promptChromeBuiltIn(session, prompt);
        });
        addValidationActivity(validation);
        plan = planOrFallback(validation, prepared.tabs);
      },
      {
        onDownloadProgress(progress) {
          setStatus(`Downloading Chrome Built-in AI model... ${Math.round(progress * 100)}%`, "");
        }
      }
    );
  } catch (error) {
    addActivity("Chrome Built-in AI failed; falling back to title/domain sort.");
    fallbackWarnings.push(
      `${error.message || String(error)} Used title sort instead. If Chrome reports missing user activation, click Sort again.`
    );
  }

  plan.warnings.push(...prepared.warnings, ...fallbackWarnings);
  describePlan(plan);
  addActivity("Applying tab moves and groups.");
  const applied = await chrome.runtime.sendMessage({
    type: "APPLY_SORT_PLAN",
    payload: { plan }
  });

  if (!applied.ok) throw new Error(applied.error);

  const suffix = applied.warnings?.length ? ` ${applied.warnings.join(" ")}` : "";
  setStatus(`${applied.message}${suffix}`, fallbackWarnings.length ? "" : "success");
  await refreshTabCount();
}

async function sortWithCloudAi(settings) {
  addActivity("Preparing tab context in the background worker.");
  setStatus("Preparing current-window tabs...", "");
  const prepared = await chrome.runtime.sendMessage({
    type: "PREPARE_SORT_INPUT",
    payload: {
      mode: mode.value,
      contextMode: contextMode.value,
      maxSnippetLength: settings.maxSnippetLength
    }
  });

  if (!prepared.ok) throw new Error(prepared.error);
  if (!prepared.tabs.length) {
    setStatus("No movable tabs found in this window.", "success");
    return;
  }

  describePreparedInput(prepared);
  addActivity("Sending structured sort request to the selected AI provider.");
  const validation = await aiSortPlan(prepared.tabs, mode.value, async (prompt, meta) => {
    announceAiPhase(providerLabel(settings.provider), meta.phase);
    return callAiProvider(settings, prompt);
  });
  addValidationActivity(validation);

  const plan = planOrFallback(validation, prepared.tabs);
  plan.warnings.push(...prepared.warnings);
  describePlan(plan);

  addActivity("Applying tab moves and groups.");
  const applied = await chrome.runtime.sendMessage({
    type: "APPLY_SORT_PLAN",
    payload: { plan }
  });

  if (!applied.ok) throw new Error(applied.error);

  const suffix = applied.warnings?.length ? ` ${applied.warnings.join(" ")}` : "";
  setStatus(`${applied.message}${suffix}`, validation.ok ? "success" : "");
  await refreshTabCount();
}

function describePreparedInput(prepared) {
  const tabs = prepared.tabs || [];
  const snippetCount = tabs.filter((tab) => tab.snippet).length;
  const historyCount = tabs.filter((tab) => tab.history).length;
  addActivity(`Prepared ${tabs.length} movable tab${tabs.length === 1 ? "" : "s"}.`);
  if (snippetCount) addActivity(`Included page snippets for ${snippetCount} tab${snippetCount === 1 ? "" : "s"}.`);
  if (historyCount) addActivity(`Included trace/history context for ${historyCount} tab${historyCount === 1 ? "" : "s"}.`);
  for (const warning of prepared.warnings || []) {
    addActivity(`Context warning: ${warning}`);
  }
}

function announceAiPhase(provider, phase) {
  if (phase === "agentic-discovery") {
    setStatus(`${provider} is drafting workflow groups...`, "");
    addActivity("AI phase 1: infer workflows and candidate groups from tab context.");
  } else if (phase === "agentic-finalize") {
    setStatus(`${provider} is refining groups...`, "");
    addActivity("AI phase 2: normalize groups, sequence tabs, and check coverage.");
  } else {
    setStatus(`${provider} is sorting tabs...`, "");
    addActivity("AI phase: infer groups and order from the prepared context.");
  }
}

function addValidationActivity(validation) {
  if (validation.ok) {
    addActivity(`Validated AI plan with ${validation.plan.groups.length} group${validation.plan.groups.length === 1 ? "" : "s"}.`);
  } else {
    addActivity(`AI plan failed validation: ${validation.reason || "unknown reason"}.`);
    addActivity("Fallback: using deterministic title/domain sort.");
  }
}

function describePlan(plan) {
  const names = plan.groups.map((group) => `${group.name} (${group.tabIds.length})`).join(", ");
  addActivity(`Final plan: ${names || "no groups"}.`);
}


async function sleepGroupsNow() {
  sleepButton.disabled = true;
  setStatus("Sleeping inactive grouped tabs...", "");
  addActivity("Battery saver requested: discard inactive tabs in tab groups.");
  try {
    const response = await chrome.runtime.sendMessage({ type: "SLEEP_GROUPS_NOW" });
    if (!response.ok) throw new Error(response.error);
    setStatus(response.message, "success");
    addActivity(response.message);
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    sleepButton.disabled = false;
  }
}
