import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS, SIMPLE_PRESETS, mergeSettings } from "../lib/settings.js";

test("DEFAULT_SETTINGS includes Chrome Built-in AI provider without changing the default", () => {
  assert.equal(DEFAULT_SETTINGS.provider, "openai");
  assert.equal(DEFAULT_SETTINGS.sortMode, "agentic");
  assert.equal(DEFAULT_SETTINGS.sortOnActionClick, false);
  assert.equal(DEFAULT_SETTINGS.providers.chromeBuiltIn.model, "Gemini Nano");
  assert.equal(DEFAULT_SETTINGS.historyContextEnabled, false);
  assert.equal(DEFAULT_SETTINGS.historyLookbackHours, 24);
  assert.equal(DEFAULT_SETTINGS.limiterEnabled, true);
  assert.equal(DEFAULT_SETTINGS.limiterProfile, "balanced");
});

test("mergeSettings preserves Chrome Built-in AI defaults", () => {
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    provider: "chromeBuiltIn",
    providers: {
      openai: { apiKey: "key" }
    }
  });

  assert.equal(settings.provider, "chromeBuiltIn");
  assert.equal(settings.providers.openai.apiKey, "key");
  assert.equal(settings.providers.chromeBuiltIn.model, "Gemini Nano");
});

test("simple presets encode max accuracy and local Chrome Nano tradeoffs", () => {
  assert.deepEqual(SIMPLE_PRESETS.max.settings, {
    provider: "openai",
    sortMode: "agentic",
    contextMode: "page",
    maxSnippetLength: 1600,
    historyContextEnabled: true,
    historyLookbackHours: 48,
    historyMaxVisitsPerTab: 10,
    historyNearbyLimit: 16,
    batterySaverEnabled: false
  });

  assert.deepEqual(SIMPLE_PRESETS.local.settings, {
    provider: "chromeBuiltIn",
    sortMode: "smart",
    contextMode: "metadata",
    maxSnippetLength: 800,
    historyContextEnabled: true,
    historyLookbackHours: 24,
    historyMaxVisitsPerTab: 6,
    historyNearbyLimit: 8,
    batterySaverEnabled: true,
    batterySaverAutoSleepMinutes: 15,
    limiterProfile: "aggressive",
    limiterStartMinutes: 5,
    limiterSleepMinutes: 15
  });
});
