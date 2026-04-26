import { SORT_PLAN_JSON_SCHEMA, extractJsonObject } from "./schema.js";
import { activeProviderSettings } from "./settings.js";

const SYSTEM_PROMPT = [
  "You are a browser tab organization engine.",
  "Return only valid JSON matching the requested schema.",
  "Never invent tab IDs. Never include a tab ID more than once."
].join(" ");

export function googleResponseSchema(schema = SORT_PLAN_JSON_SCHEMA) {
  if (Array.isArray(schema)) {
    return schema.map((item) => googleResponseSchema(item));
  }

  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue;
    output[key] = googleResponseSchema(value);
  }
  return output;
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function createOpenAIRequest(provider, prompt) {
  return {
    url: "https://api.openai.com/v1/responses",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model || "gpt-5.4-mini",
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "tab_sort_plan",
            strict: true,
            schema: SORT_PLAN_JSON_SCHEMA
          }
        }
      })
    }
  };
}

export function createCompatibleRequest(provider, prompt) {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  return {
    url: `${baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model || "gpt-5.4-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "tab_sort_plan",
            strict: true,
            schema: SORT_PLAN_JSON_SCHEMA
          }
        }
      })
    }
  };
}

export function createVertexRequest(provider, prompt) {
  const location = provider.location || "us-central1";
  const projectId = provider.projectId || "";
  const model = provider.model || "gemini-2.5-flash";
  return {
    url: `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.accessToken}`
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\n${prompt}` }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: googleResponseSchema()
        }
      })
    }
  };
}

export function createGeminiRequest(provider, prompt) {
  const model = provider.model || "gemini-2.5-flash";
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey || "")}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\n${prompt}` }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: googleResponseSchema()
        }
      })
    }
  };
}

export function providerRequest(settings, prompt) {
  const providerName = settings.provider || "openai";
  const provider = activeProviderSettings(settings);

  if (providerName === "openai") return createOpenAIRequest(provider, prompt);
  if (providerName === "compatible") return createCompatibleRequest(provider, prompt);
  if (providerName === "vertex") return createVertexRequest(provider, prompt);
  if (providerName === "gemini") return createGeminiRequest(provider, prompt);

  throw new Error(`Unsupported provider: ${providerName}`);
}

export function validateProviderSettings(settings) {
  const providerName = settings.provider || "openai";
  const provider = activeProviderSettings(settings);

  if (providerName === "chromeBuiltIn") {
    return;
  }

  if (providerName === "openai" && !provider.apiKey) {
    throw new Error("Add an OpenAI API key in Options first.");
  }

  if (providerName === "compatible") {
    if (!provider.baseUrl) throw new Error("Add a custom API base URL in Options first.");
    if (!provider.apiKey) throw new Error("Add a custom provider API key in Options first.");
  }

  if (providerName === "vertex") {
    if (!provider.projectId) throw new Error("Add a Vertex AI project ID in Options first.");
    if (!provider.accessToken) throw new Error("Add a Vertex AI access token in Options first.");
  }

  if (providerName === "gemini" && !provider.apiKey) {
    throw new Error("Add a Gemini API key in Options first.");
  }
}

export function extractProviderText(providerName, payload) {
  if (providerName === "openai") {
    if (typeof payload.output_text === "string") {
      return payload.output_text;
    }

    const parts = payload.output?.flatMap((item) => item.content || []) || [];
    const text = parts.map((part) => part.text || "").join("\n").trim();
    if (text) return text;
  }

  if (providerName === "compatible") {
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text === "string") return text;
  }

  if (providerName === "vertex" || providerName === "gemini") {
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
    if (typeof text === "string") return text;
  }

  throw new Error("Provider response did not contain text output.");
}

export async function callAiProvider(settings, prompt) {
  validateProviderSettings(settings);
  const providerName = settings.provider || "openai";
  const request = providerRequest(settings, prompt);
  const response = await fetch(request.url, request.init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload.error?.message || payload.error || response.statusText;
    throw new Error(`AI provider request failed: ${message}`);
  }

  return extractJsonObject(extractProviderText(providerName, payload));
}

export async function testProvider(settings) {
  const prompt = [
    "Return a valid tab sort plan for this single tab.",
    JSON.stringify([{ id: 1, title: "Example", url: "https://example.com", domain: "example.com" }])
  ].join("\n");
  const result = await callAiProvider(settings, prompt);
  return Boolean(result?.groups);
}
