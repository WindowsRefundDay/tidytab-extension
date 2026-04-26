import { SORT_PLAN_JSON_SCHEMA, extractJsonObject } from "./schema.js";

export const CHROME_BUILT_IN_PROVIDER = "chromeBuiltIn";

export const CHROME_BUILT_IN_CAPABILITIES = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
};

const SYSTEM_PROMPT = [
  "You are a browser tab organization engine.",
  "Return only valid JSON matching the requested schema.",
  "Never invent tab IDs. Never include a tab ID more than once."
].join(" ");

export function getLanguageModel(runtime = globalThis) {
  return runtime.LanguageModel || runtime.ai?.languageModel || null;
}

export async function checkChromeBuiltInAvailability(runtime = globalThis) {
  const languageModel = getLanguageModel(runtime);
  if (!languageModel?.availability) {
    return {
      available: false,
      status: "unsupported",
      message: "Chrome Built-in AI is not available in this browser. Use Chrome 138+ on a supported desktop device."
    };
  }

  const status = await languageModel.availability(CHROME_BUILT_IN_CAPABILITIES);
  return {
    available: status === "available" || status === "readily",
    status,
    message: availabilityMessage(status)
  };
}

export function availabilityMessage(status) {
  if (status === "available" || status === "readily") {
    return "Chrome Built-in AI is ready.";
  }
  if (status === "downloadable" || status === "after-download") {
    return "Chrome Built-in AI is available after a first-time model download.";
  }
  if (status === "downloading") {
    return "Chrome Built-in AI model is still downloading.";
  }
  if (status === "unavailable" || status === "no") {
    return "Chrome Built-in AI is unavailable on this device or Chrome version.";
  }
  return `Chrome Built-in AI status: ${status || "unknown"}.`;
}

export async function createChromeBuiltInSession(options = {}) {
  const runtime = options.runtime || globalThis;
  const languageModel = getLanguageModel(runtime);
  if (!languageModel?.create) {
    throw new Error("Chrome Built-in AI is not available in this browser.");
  }

  const availability = await checkChromeBuiltInAvailability(runtime);
  if (availability.status === "unavailable" || availability.status === "no" || availability.status === "unsupported") {
    throw new Error(availability.message);
  }

  const session = await languageModel.create({
    ...CHROME_BUILT_IN_CAPABILITIES,
    initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
    monitor(monitor) {
      monitor.addEventListener?.("downloadprogress", (event) => {
        const loaded = Number(event.loaded ?? 0);
        const total = Number(event.total ?? 1) || 1;
        const progress = Math.max(0, Math.min(1, loaded / total));
        options.onDownloadProgress?.(progress);
      });
    }
  });

  return session;
}

export async function promptChromeBuiltIn(session, prompt) {
  const response = await session.prompt(prompt, {
    responseConstraint: SORT_PLAN_JSON_SCHEMA
  });
  return extractJsonObject(response);
}

export async function withChromeBuiltInSession(callback, options = {}) {
  const session = await createChromeBuiltInSession(options);
  try {
    return await callback(session);
  } finally {
    session.destroy?.();
  }
}

export async function testChromeBuiltInProvider(options = {}) {
  return withChromeBuiltInSession(
    async (session) => {
      const result = await promptChromeBuiltIn(
        session,
        [
          "Return a valid tab sort plan for this single tab.",
          JSON.stringify([{ id: 1, title: "Example", url: "https://example.com", domain: "example.com" }])
        ].join("\n")
      );
      return Boolean(result?.groups);
    },
    options
  );
}
