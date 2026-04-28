import {
  DEFAULT_SETTINGS,
  SIMPLE_PRESETS,
  loadSettings,
  mergeSettings,
  normalizeCustomOrigin,
  resetSettings,
  saveSettings
} from "./lib/settings.js";
import { testProvider } from "./lib/providers.js";
import { CHROME_BUILT_IN_PROVIDER, checkChromeBuiltInAvailability, testChromeBuiltInProvider } from "./lib/chromeBuiltIn.js";

const fields = {
  presets: [...document.querySelectorAll('input[name="preset"]')],
  provider: document.querySelector("#provider"),
  sortMode: document.querySelector("#sortMode"),
  contextMode: document.querySelector("#contextMode"),
  maxSnippetLength: document.querySelector("#maxSnippetLength"),
  historyContextEnabled: document.querySelector("#historyContextEnabled"),
  historyLookbackHours: document.querySelector("#historyLookbackHours"),
  historyMaxVisitsPerTab: document.querySelector("#historyMaxVisitsPerTab"),
  historyNearbyLimit: document.querySelector("#historyNearbyLimit"),
  batterySaverEnabled: document.querySelector("#batterySaverEnabled"),
  batterySaverAutoSleepMinutes: document.querySelector("#batterySaverAutoSleepMinutes"),
  batterySaverDiscardAudioTabs: document.querySelector("#batterySaverDiscardAudioTabs"),
  batterySaverCollapseGroupsAfterSleep: document.querySelector("#batterySaverCollapseGroupsAfterSleep"),
  limiterEnabled: document.querySelector("#limiterEnabled"),
  limiterProfile: document.querySelector("#limiterProfile"),
  limiterStartMinutes: document.querySelector("#limiterStartMinutes"),
  limiterSleepMinutes: document.querySelector("#limiterSleepMinutes"),
  openaiApiKey: document.querySelector("#openaiApiKey"),
  openaiModel: document.querySelector("#openaiModel"),
  compatibleBaseUrl: document.querySelector("#compatibleBaseUrl"),
  compatibleApiKey: document.querySelector("#compatibleApiKey"),
  compatibleModel: document.querySelector("#compatibleModel"),
  vertexProjectId: document.querySelector("#vertexProjectId"),
  vertexLocation: document.querySelector("#vertexLocation"),
  vertexModel: document.querySelector("#vertexModel"),
  vertexAccessToken: document.querySelector("#vertexAccessToken"),
  geminiApiKey: document.querySelector("#geminiApiKey"),
  geminiModel: document.querySelector("#geminiModel")
};

const saveButton = document.querySelector("#saveButton");
const testButton = document.querySelector("#testButton");
const resetButton = document.querySelector("#resetButton");
const availabilityButton = document.querySelector("#availabilityButton");
const status = document.querySelector("#status");

let currentSettings = structuredClone(DEFAULT_SETTINGS);

init();

async function init() {
  currentSettings = await loadSettings();
  render(currentSettings);

  fields.provider.addEventListener("change", () => {
    showProvider(fields.provider.value);
    syncPresetSelection(readForm());
  });
  fields.presets.forEach((preset) => {
    preset.addEventListener("change", () => {
      if (!preset.checked) return;
      applyPreset(preset.value);
    });
  });
  advancedFields().forEach((field) => {
    field.addEventListener("change", () => syncPresetSelection(readForm()));
    field.addEventListener("input", () => syncPresetSelection(readForm()));
  });
  saveButton.addEventListener("click", save);
  testButton.addEventListener("click", test);
  resetButton.addEventListener("click", reset);
  availabilityButton.addEventListener("click", checkAvailability);
}

function render(settings) {
  fields.provider.value = settings.provider;
  fields.sortMode.value = settings.sortMode;
  fields.contextMode.value = settings.contextMode;
  fields.maxSnippetLength.value = settings.maxSnippetLength;
  fields.historyContextEnabled.checked = Boolean(settings.historyContextEnabled);
  fields.historyLookbackHours.value = settings.historyLookbackHours;
  fields.historyMaxVisitsPerTab.value = settings.historyMaxVisitsPerTab;
  fields.historyNearbyLimit.value = settings.historyNearbyLimit;
  fields.batterySaverEnabled.checked = Boolean(settings.batterySaverEnabled);
  fields.batterySaverAutoSleepMinutes.value = settings.batterySaverAutoSleepMinutes;
  fields.batterySaverDiscardAudioTabs.checked = Boolean(settings.batterySaverDiscardAudioTabs);
  fields.batterySaverCollapseGroupsAfterSleep.checked = Boolean(settings.batterySaverCollapseGroupsAfterSleep);
  fields.limiterEnabled.checked = Boolean(settings.limiterEnabled);
  fields.limiterProfile.value = settings.limiterProfile;
  fields.limiterStartMinutes.value = settings.limiterStartMinutes;
  fields.limiterSleepMinutes.value = settings.limiterSleepMinutes;
  fields.openaiApiKey.value = settings.providers.openai.apiKey;
  fields.openaiModel.value = settings.providers.openai.model;
  fields.compatibleBaseUrl.value = settings.providers.compatible.baseUrl;
  fields.compatibleApiKey.value = settings.providers.compatible.apiKey;
  fields.compatibleModel.value = settings.providers.compatible.model;
  fields.vertexProjectId.value = settings.providers.vertex.projectId;
  fields.vertexLocation.value = settings.providers.vertex.location;
  fields.vertexModel.value = settings.providers.vertex.model;
  fields.vertexAccessToken.value = settings.providers.vertex.accessToken;
  fields.geminiApiKey.value = settings.providers.gemini.apiKey;
  fields.geminiModel.value = settings.providers.gemini.model;
  showProvider(settings.provider);
  syncPresetSelection(settings);
}

function readForm() {
  return {
    provider: fields.provider.value,
    sortMode: fields.sortMode.value,
    contextMode: fields.contextMode.value,
    maxSnippetLength: clamp(Number(fields.maxSnippetLength.value) || DEFAULT_SETTINGS.maxSnippetLength, 300, 4000),
    historyContextEnabled: fields.historyContextEnabled.checked,
    historyLookbackHours: clamp(Number(fields.historyLookbackHours.value) || DEFAULT_SETTINGS.historyLookbackHours, 1, 168),
    historyMaxVisitsPerTab: clamp(
      Number(fields.historyMaxVisitsPerTab.value) || DEFAULT_SETTINGS.historyMaxVisitsPerTab,
      1,
      25
    ),
    historyNearbyLimit: clamp(Number(fields.historyNearbyLimit.value) || DEFAULT_SETTINGS.historyNearbyLimit, 0, 50),
    batterySaverEnabled: fields.batterySaverEnabled.checked,
    batterySaverAutoSleepMinutes: clamp(Number(fields.batterySaverAutoSleepMinutes.value) || DEFAULT_SETTINGS.batterySaverAutoSleepMinutes, 5, 240),
    batterySaverDiscardAudioTabs: fields.batterySaverDiscardAudioTabs.checked,
    batterySaverCollapseGroupsAfterSleep: fields.batterySaverCollapseGroupsAfterSleep.checked,
    limiterEnabled: fields.limiterEnabled.checked,
    limiterProfile: fields.limiterProfile.value,
    limiterStartMinutes: clamp(Number(fields.limiterStartMinutes.value) || DEFAULT_SETTINGS.limiterStartMinutes, 1, 120),
    limiterSleepMinutes: clamp(Number(fields.limiterSleepMinutes.value) || DEFAULT_SETTINGS.limiterSleepMinutes, 5, 360),
    providers: {
      openai: {
        apiKey: fields.openaiApiKey.value.trim(),
        model: fields.openaiModel.value.trim() || DEFAULT_SETTINGS.providers.openai.model
      },
      compatible: {
        baseUrl: fields.compatibleBaseUrl.value.trim(),
        apiKey: fields.compatibleApiKey.value.trim(),
        model: fields.compatibleModel.value.trim() || DEFAULT_SETTINGS.providers.compatible.model
      },
      vertex: {
        projectId: fields.vertexProjectId.value.trim(),
        location: fields.vertexLocation.value.trim() || DEFAULT_SETTINGS.providers.vertex.location,
        model: fields.vertexModel.value.trim() || DEFAULT_SETTINGS.providers.vertex.model,
        accessToken: fields.vertexAccessToken.value.trim()
      },
      gemini: {
        apiKey: fields.geminiApiKey.value.trim(),
        model: fields.geminiModel.value.trim() || DEFAULT_SETTINGS.providers.gemini.model
      },
      chromeBuiltIn: {
        model: DEFAULT_SETTINGS.providers.chromeBuiltIn.model
      }
    }
  };
}

function applyPreset(name) {
  const preset = SIMPLE_PRESETS[name];
  if (!preset) return;

  const nextSettings = mergeSettings(readForm(), preset.settings);
  render(nextSettings);
  setStatus(`${preset.label} preset selected. Save to apply permissions and keep it as your default.`, "");
}

function syncPresetSelection(settings) {
  const matchingPreset = fields.presets.find((preset) => settingsMatchesPreset(settings, SIMPLE_PRESETS[preset.value]?.settings));
  fields.presets.forEach((preset) => {
    preset.checked = preset === matchingPreset;
  });
}

function settingsMatchesPreset(settings, presetSettings) {
  if (!presetSettings) return false;

  return Object.entries(presetSettings).every(([key, value]) => settings[key] === value);
}

function advancedFields() {
  return [
    fields.provider,
    fields.sortMode,
    fields.contextMode,
    fields.maxSnippetLength,
    fields.historyContextEnabled,
    fields.historyLookbackHours,
    fields.historyMaxVisitsPerTab,
    fields.historyNearbyLimit,
    fields.batterySaverEnabled,
    fields.batterySaverAutoSleepMinutes,
    fields.batterySaverDiscardAudioTabs,
    fields.batterySaverCollapseGroupsAfterSleep,
    fields.limiterEnabled,
    fields.limiterProfile,
    fields.limiterStartMinutes,
    fields.limiterSleepMinutes,
    fields.openaiModel,
    fields.compatibleBaseUrl,
    fields.compatibleModel,
    fields.vertexProjectId,
    fields.vertexLocation,
    fields.vertexModel,
    fields.geminiModel
  ];
}

async function save() {
  try {
    const settings = readForm();
    await requestOptionalPermissions(settings);
    currentSettings = await saveSettings(settings);
    render(currentSettings);
    setStatus("Options saved.", "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

async function test() {
  testButton.disabled = true;
  setStatus("Testing provider...", "");
  try {
    const settings = readForm();
    await requestOptionalPermissions(settings);
    await saveSettings(settings);
    if (settings.provider === CHROME_BUILT_IN_PROVIDER) {
      await testChromeBuiltInProvider({
        onDownloadProgress(progress) {
          setStatus(`Downloading Chrome Built-in AI model... ${Math.round(progress * 100)}%`, "");
        }
      });
    } else {
      await testProvider(settings);
    }
    setStatus("Provider returned a valid response.", "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    testButton.disabled = false;
  }
}

async function reset() {
  currentSettings = await resetSettings();
  render(currentSettings);
  setStatus("Options reset.", "success");
}

async function requestOptionalPermissions(settings) {
  if (settings.contextMode === "page") {
    const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
    if (!granted) throw new Error("Page snippets require site access.");
  }

  if (settings.historyContextEnabled) {
    const granted = await chrome.permissions.request({ permissions: ["history"] });
    if (!granted) throw new Error("History context requires history permission.");
  }

  if (settings.provider === "compatible" && settings.providers.compatible.baseUrl) {
    const origin = normalizeCustomOrigin(settings.providers.compatible.baseUrl);
    if (origin) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error("Custom API endpoint permission was not granted.");
    }
  }
}

async function checkAvailability() {
  availabilityButton.disabled = true;
  setStatus("Checking Chrome Built-in AI availability...", "");
  try {
    const availability = await checkChromeBuiltInAvailability();
    setStatus(availability.message, availability.available ? "success" : "");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    availabilityButton.disabled = false;
  }
}

function showProvider(provider) {
  document.querySelectorAll("[data-provider-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.providerPanel === provider);
  });
}

function setStatus(message, className) {
  status.textContent = message;
  status.className = `status ${className}`.trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
