export const DEFAULT_SETTINGS = {
  provider: "openai",
  sortMode: "agentic",
  sortOnActionClick: false,
  contextMode: "metadata",
  maxSnippetLength: 1200,
  historyContextEnabled: false,
  historyLookbackHours: 24,
  historyMaxVisitsPerTab: 8,
  historyNearbyLimit: 12,
  providers: {
    openai: {
      apiKey: "",
      model: "gpt-5.4-mini"
    },
    compatible: {
      apiKey: "",
      baseUrl: "",
      model: "gpt-5.4-mini"
    },
    vertex: {
      accessToken: "",
      projectId: "",
      location: "us-central1",
      model: "gemini-2.5-flash"
    },
    gemini: {
      apiKey: "",
      model: "gemini-2.5-flash"
    },
    chromeBuiltIn: {
      model: "Gemini Nano"
    }
  }
};

export const SIMPLE_PRESETS = {
  max: {
    label: "Max accuracy",
    description: "Uses cloud AI, page snippets, and history trace context for the best personalized grouping.",
    settings: {
      provider: "openai",
      sortMode: "agentic",
      contextMode: "page",
      maxSnippetLength: 1600,
      historyContextEnabled: true,
      historyLookbackHours: 48,
      historyMaxVisitsPerTab: 10,
      historyNearbyLimit: 16
    }
  },
  local: {
    label: "Local Chrome Nano",
    description: "Keeps sorting onboard with Chrome Built-in AI and a smaller context budget.",
    settings: {
      provider: "chromeBuiltIn",
      sortMode: "smart",
      contextMode: "metadata",
      maxSnippetLength: 800,
      historyContextEnabled: true,
      historyLookbackHours: 24,
      historyMaxVisitsPerTab: 6,
      historyNearbyLimit: 8
    }
  }
};

const STORAGE_KEY = "aiTabSorterSettings";

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function mergeSettings(base, override) {
  const output = structuredClone(base);
  const apply = (target, source) => {
    if (!isObject(source)) return target;
    for (const [key, value] of Object.entries(source)) {
      if (isObject(value) && isObject(target[key])) {
        apply(target[key], value);
      } else {
        target[key] = value;
      }
    }
    return target;
  };
  return apply(output, override);
}

export async function loadSettings() {
  if (!globalThis.chrome?.storage?.local) {
    return structuredClone(DEFAULT_SETTINGS);
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  return mergeSettings(DEFAULT_SETTINGS, result[STORAGE_KEY]);
}

export async function saveSettings(settings) {
  if (!globalThis.chrome?.storage?.local) {
    return settings;
  }

  const merged = mergeSettings(DEFAULT_SETTINGS, settings);
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return merged;
}

export async function resetSettings() {
  if (!globalThis.chrome?.storage?.local) {
    return structuredClone(DEFAULT_SETTINGS);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: structuredClone(DEFAULT_SETTINGS) });
  return structuredClone(DEFAULT_SETTINGS);
}

export function activeProviderSettings(settings) {
  const provider = settings.provider || DEFAULT_SETTINGS.provider;
  return settings.providers?.[provider] || DEFAULT_SETTINGS.providers[provider];
}

export function normalizeCustomOrigin(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return "";
  }
}
