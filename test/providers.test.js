import test from "node:test";
import assert from "node:assert/strict";

import {
  createCompatibleRequest,
  createGeminiRequest,
  createOpenAIRequest,
  createVertexRequest,
  extractProviderText,
  googleResponseSchema,
  normalizeBaseUrl,
  providerRequest,
  validateProviderSettings
} from "../lib/providers.js";

test("normalizeBaseUrl trims trailing slashes", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com/v1///"), "https://api.example.com/v1");
});

test("createOpenAIRequest targets Responses API with JSON schema", () => {
  const request = createOpenAIRequest({ apiKey: "key", model: "gpt-test" }, "Sort tabs");
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(body.model, "gpt-test");
  assert.equal(body.text.format.type, "json_schema");
});

test("createCompatibleRequest targets chat completions", () => {
  const request = createCompatibleRequest(
    { apiKey: "key", model: "model", baseUrl: "https://api.example.com/v1/" },
    "Sort tabs"
  );
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(body.response_format.type, "json_schema");
});

test("createVertexRequest builds regional Vertex generateContent endpoint", () => {
  const request = createVertexRequest(
    { accessToken: "token", projectId: "proj", location: "us-central1", model: "gemini-test" },
    "Sort tabs"
  );
  const body = JSON.parse(request.init.body);
  assert.match(request.url, /us-central1-aiplatform\.googleapis\.com/);
  assert.match(request.url, /projects\/proj\/locations\/us-central1\/publishers\/google\/models\/gemini-test:generateContent/);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema.additionalProperties, undefined);
  assert.equal(body.generationConfig.responseSchema.properties.groups.items.additionalProperties, undefined);
});

test("createGeminiRequest builds API-key Gemini request", () => {
  const request = createGeminiRequest({ apiKey: "key", model: "gemini-test" }, "Sort tabs");
  const body = JSON.parse(request.init.body);
  assert.match(request.url, /generativelanguage\.googleapis\.com/);
  assert.match(request.url, /key=key/);
  assert.equal(body.generationConfig.responseSchema.additionalProperties, undefined);
  assert.equal(body.generationConfig.responseSchema.properties.groups.items.additionalProperties, undefined);
});

test("googleResponseSchema strips unsupported nested JSON Schema fields", () => {
  const schema = googleResponseSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      nested: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "string" }
        }
      }
    }
  });

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      nested: {
        type: "object",
        properties: {
          value: { type: "string" }
        }
      }
    }
  });
});

test("providerRequest dispatches by active provider", () => {
  const request = providerRequest(
    {
      provider: "compatible",
      providers: {
        compatible: { apiKey: "key", baseUrl: "https://api.example.com/v1", model: "m" }
      }
    },
    "Sort tabs"
  );
  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
});

test("validateProviderSettings reports missing credentials", () => {
  assert.throws(
    () =>
      validateProviderSettings({
        provider: "openai",
        providers: { openai: { apiKey: "" } }
      }),
    /OpenAI API key/
  );
});

test("validateProviderSettings accepts Chrome Built-in AI without credentials", () => {
  assert.doesNotThrow(() =>
    validateProviderSettings({
      provider: "chromeBuiltIn",
      providers: { chromeBuiltIn: { model: "Gemini Nano" } }
    })
  );
});

test("extractProviderText handles provider response shapes", () => {
  assert.equal(extractProviderText("openai", { output_text: "{}" }), "{}");
  assert.equal(extractProviderText("compatible", { choices: [{ message: { content: "{}" } }] }), "{}");
  assert.equal(
    extractProviderText("gemini", { candidates: [{ content: { parts: [{ text: "{" }, { text: "}" }] } }] }),
    "{}"
  );
});
