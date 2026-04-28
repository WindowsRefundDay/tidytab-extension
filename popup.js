import { loadSettings } from "./lib/settings.js";
import { CHROME_BUILT_IN_PROVIDER, promptChromeBuiltIn, withChromeBuiltInSession } from "./lib/chromeBuiltIn.js";
import { SORT_MODES, aiSortPlan, planOrFallback, titleSortPlan } from "./lib/sorters.js";

const SORT_STATUS_KEY = "aiTabSorterSortStatus";

const sortButton = document.querySelector("#sortButton");
const undoButton = document.querySelector("#undoButton");
const optionsButton = document.querySelector("#optionsButton");
const clearLogButton = document.querySelector("#clearLogButton");
const localAiWarning = document.querySelector("#localAiWarning");
const keepOpenModal = document.querySelector("#keepOpenModal");
const status = document.querySelector("#status");
const activityLog = document.querySelector("#activityLog");

init();

async function init() {
  sortButton.addEventListener("click", startSort);
  undoButton.addEventListener("click", undoSort);
  optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  clearLogButton.addEventListener("click", clearActivity);
  chrome.storage.onChanged.addListener(handleStorageChange);
  await updateLocalAiWarning();
  await restoreStatus();
}

async function startSort() {
  sortButton.disabled = true;
  setStatus("Sorting tabs...", "");
  renderSteps([{ message: "Starting background sort.", state: "active" }]);

  try {
    const settings = await loadSettings();
    toggleLocalAiWarning(settings);
    if (settings.contextMode === "page" && settings.sortMode !== SORT_MODES.TITLE) {
      setStatus("Requesting page access...", "");
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
      if (!granted) {
        throw new Error("Page snippets need site access. Switch to Title + URL or grant access.");
      }
    }

    if (usesPopupLocalAi(settings)) {
      await sortWithChromeBuiltIn(settings);
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: "START_SORT_PROCESS" });
    if (!response.ok) throw new Error(response.error);
    renderSortStatus(response.status);
  } catch (error) {
    renderSortStatus({
      running: false,
      message: error.message || String(error),
      className: "error",
      steps: [{ message: error.message || String(error), className: "error", state: "active" }]
    });
  } finally {
    sortButton.disabled = false;
  }
}

async function updateLocalAiWarning() {
  toggleLocalAiWarning(await loadSettings());
}

function toggleLocalAiWarning(settings) {
  localAiWarning.hidden = !usesPopupLocalAi(settings);
}

function usesPopupLocalAi(settings) {
  return settings.provider === CHROME_BUILT_IN_PROVIDER && settings.sortMode !== SORT_MODES.TITLE;
}

async function sortWithChromeBuiltIn(settings) {
  showKeepOpenModal();
  renderSortStatus({
    running: true,
    message: "Keep this popup open while Chrome Built-in AI sorts.",
    className: "",
    steps: [
      { message: "Chrome Built-in AI is running inside this popup.", state: "complete" },
      { message: "Do not close this popup until sorting finishes.", state: "active" }
    ]
  });

  try {
    const prepared = await prepareSortInput(settings);
    if (!prepared) return;

    let plan = titleSortPlan(prepared.tabs);
    const fallbackWarnings = [];

    try {
      addStep("Creating local Chrome Built-in AI session.");
      setStatus("Starting Chrome Built-in AI. A first-time model download may be required...", "");
      await withChromeBuiltInSession(
        async (session) => {
          const validation = await aiSortPlan(prepared.tabs, settings.sortMode, async (prompt, meta) => {
            announceAiPhase("Chrome Built-in AI", meta.phase);
            return promptChromeBuiltIn(session, prompt);
          });
          addValidationStep(validation);
          plan = planOrFallback(validation, prepared.tabs);
        },
        {
          onDownloadProgress(progress) {
            setStatus(`Downloading Chrome Built-in AI model... ${Math.round(progress * 100)}%`, "");
          }
        }
      );
    } catch (error) {
      addStep("Chrome Built-in AI failed; falling back to title/domain sort.");
      fallbackWarnings.push(`${error.message || String(error)} Used title sort instead.`);
    }

    plan.warnings.push(...prepared.warnings, ...fallbackWarnings);
    describePlan(plan);
    await applySortPlan(plan, fallbackWarnings.length ? "" : "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
    addStep(error.message || String(error), "error");
  } finally {
    hideKeepOpenModal();
    sortButton.disabled = false;
  }
}

function showKeepOpenModal() {
  keepOpenModal.hidden = false;
}

function hideKeepOpenModal() {
  keepOpenModal.hidden = true;
}

async function prepareSortInput(settings) {
  addStep("Preparing current-window tabs.");
  setStatus("Preparing current-window tabs...", "");
  const prepared = await chrome.runtime.sendMessage({
    type: "PREPARE_SORT_INPUT",
    payload: {
      mode: settings.sortMode,
      contextMode: settings.contextMode,
      maxSnippetLength: settings.maxSnippetLength
    }
  });

  if (!prepared.ok) throw new Error(prepared.error);
  if (!prepared.tabs.length) {
    setStatus("No movable tabs found in this window.", "success");
    return null;
  }

  describePreparedInput(prepared);
  return prepared;
}

async function applySortPlan(plan, statusClass) {
  addStep("Applying tab moves and groups.");
  const applied = await chrome.runtime.sendMessage({
    type: "APPLY_SORT_PLAN",
    payload: { plan }
  });

  if (!applied.ok) throw new Error(applied.error);

  const suffix = applied.warnings?.length ? ` ${applied.warnings.join(" ")}` : "";
  setStatus(`${applied.message}${suffix}`, statusClass);
}

function describePreparedInput(prepared) {
  const tabs = prepared.tabs || [];
  const snippetCount = tabs.filter((tab) => tab.snippet).length;
  const historyCount = tabs.filter((tab) => tab.history).length;
  addStep(`Prepared ${tabs.length} movable tab${tabs.length === 1 ? "" : "s"}.`);
  if (snippetCount) addStep(`Included page snippets for ${snippetCount} tab${snippetCount === 1 ? "" : "s"}.`);
  if (historyCount) addStep(`Included history signal for ${historyCount} tab${historyCount === 1 ? "" : "s"}.`);
  for (const warning of prepared.warnings || []) {
    addStep(`Warning: ${warning}`);
  }
}

function announceAiPhase(provider, phase) {
  if (phase === "agentic-discovery") {
    setStatus(`${provider} is drafting workflow groups...`, "");
    addStep("AI phase 1: infer workflows and candidate groups.");
  } else if (phase === "agentic-finalize") {
    setStatus(`${provider} is refining groups...`, "");
    addStep("AI phase 2: normalize groups, sequence tabs, and check coverage.");
  } else {
    setStatus(`${provider} is sorting tabs...`, "");
    addStep("AI phase: infer groups and order.");
  }
}

function addValidationStep(validation) {
  if (validation.ok) {
    addStep(`Validated AI plan with ${validation.plan.groups.length} group${validation.plan.groups.length === 1 ? "" : "s"}.`);
  } else {
    addStep(`AI plan failed validation: ${validation.reason || "unknown reason"}.`);
    addStep("Fallback: using deterministic title/domain sort.");
  }
}

function describePlan(plan) {
  const names = plan.groups.map((group) => `${group.name} (${group.tabIds.length})`).join(", ");
  addStep(`Final plan: ${names || "no groups"}.`);
}

function addStep(message, className = "") {
  const steps = [...activityLog.querySelectorAll(".activity-step")].map((item) => ({
    message: item.textContent,
    state: item.classList.contains("is-complete") ? "complete" : "active",
    className: item.classList.contains("error") ? "error" : ""
  }));
  const last = steps.at(-1);
  if (last && last.state === "active") last.state = "complete";
  steps.push({ message, state: "active", className });
  renderSteps(steps);
}

async function undoSort() {
  sortButton.disabled = true;
  undoButton.disabled = true;
  setStatus("Restoring last sort...", "");
  renderSteps([{ message: "Restoring the last pre-sort snapshot.", state: "active" }]);

  try {
    const response = await chrome.runtime.sendMessage({ type: "UNDO_LAST_SORT" });
    if (!response.ok) throw new Error(response.error);

    const suffix = response.warnings?.length ? ` ${response.warnings.join(" ")}` : "";
    setStatus(`${response.message}${suffix}`, "success");
    renderSteps([{ message: "Restore complete.", state: "complete" }]);
  } catch (error) {
    setStatus(error.message || String(error), "error");
    renderSteps([{ message: error.message || String(error), className: "error", state: "active" }]);
  } finally {
    sortButton.disabled = false;
    undoButton.disabled = false;
  }
}

async function restoreStatus() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SORT_STATUS" });
  if (!response.ok) {
    setStatus(response.error || "Could not load status.", "error");
    return;
  }
  renderSortStatus(response.status);
}

async function clearActivity() {
  const response = await chrome.runtime.sendMessage({ type: "CLEAR_SORT_STATUS" });
  if (response.ok) {
    renderSortStatus(response.status);
    return;
  }
  activityLog.replaceChildren();
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local" || !changes[SORT_STATUS_KEY]) return;
  renderSortStatus(changes[SORT_STATUS_KEY].newValue);
}

function renderSortStatus(sortStatus) {
  const current = sortStatus || {};
  setStatus(current.message || "", current.className || "");
  renderSteps(current.steps || []);
  sortButton.disabled = Boolean(current.running);
}

function renderSteps(steps) {
  activityLog.replaceChildren();
  for (const step of steps) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = step.message;
    item.className = `activity-step ${step.state === "complete" ? "is-complete" : "is-active"} ${step.className || ""}`.trim();
    item.append(text);
    activityLog.append(item);
  }
  activityLog.scrollTop = activityLog.scrollHeight;
}

function setStatus(message, className) {
  status.textContent = message;
  status.className = `status ${className}`.trim();
}
