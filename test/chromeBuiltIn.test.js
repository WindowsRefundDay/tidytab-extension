import test from "node:test";
import assert from "node:assert/strict";

import {
  CHROME_BUILT_IN_CAPABILITIES,
  availabilityMessage,
  checkChromeBuiltInAvailability,
  createChromeBuiltInSession,
  promptChromeBuiltIn,
  testChromeBuiltInProvider,
  withChromeBuiltInSession
} from "../lib/chromeBuiltIn.js";
import { SORT_PLAN_JSON_SCHEMA } from "../lib/schema.js";

test("checkChromeBuiltInAvailability reports unsupported runtime", async () => {
  const availability = await checkChromeBuiltInAvailability({});
  assert.equal(availability.available, false);
  assert.equal(availability.status, "unsupported");
});

test("checkChromeBuiltInAvailability handles available and downloadable statuses", async () => {
  const available = await checkChromeBuiltInAvailability({
    LanguageModel: { availability: async () => "available" }
  });
  const downloadable = await checkChromeBuiltInAvailability({
    LanguageModel: { availability: async () => "downloadable" }
  });

  assert.equal(available.available, true);
  assert.equal(downloadable.available, false);
  assert.match(downloadable.message, /download/);
});

test("availabilityMessage handles current and legacy status values", () => {
  assert.match(availabilityMessage("readily"), /ready/);
  assert.match(availabilityMessage("after-download"), /download/);
  assert.match(availabilityMessage("no"), /unavailable/);
});

test("createChromeBuiltInSession passes capabilities and download monitor", async () => {
  let createOptions;
  let progress = 0;
  const session = { destroy() {} };
  const runtime = {
    LanguageModel: {
      availability: async () => "downloadable",
      create: async (options) => {
        createOptions = options;
        options.monitor({
          addEventListener(_event, handler) {
            handler({ loaded: 2, total: 4 });
          }
        });
        return session;
      }
    }
  };

  const actual = await createChromeBuiltInSession({
    runtime,
    onDownloadProgress(value) {
      progress = value;
    }
  });

  assert.equal(actual, session);
  assert.deepEqual(createOptions.expectedInputs, CHROME_BUILT_IN_CAPABILITIES.expectedInputs);
  assert.deepEqual(createOptions.expectedOutputs, CHROME_BUILT_IN_CAPABILITIES.expectedOutputs);
  assert.equal(progress, 0.5);
});

test("promptChromeBuiltIn uses responseConstraint schema", async () => {
  let promptOptions;
  const session = {
    async prompt(_prompt, options) {
      promptOptions = options;
      return JSON.stringify({
        groups: [{ name: "Example", color: "blue", tabIds: [1], confidence: 1 }],
        ungroupedTabIds: [],
        warnings: []
      });
    }
  };

  const result = await promptChromeBuiltIn(session, "Sort one tab");
  assert.equal(promptOptions.responseConstraint, SORT_PLAN_JSON_SCHEMA);
  assert.equal(result.groups[0].name, "Example");
});

test("withChromeBuiltInSession destroys sessions on success and failure", async () => {
  let destroyed = 0;
  const runtime = {
    LanguageModel: {
      availability: async () => "available",
      create: async () => ({
        destroy() {
          destroyed += 1;
        }
      })
    }
  };

  await withChromeBuiltInSession(async () => true, { runtime });
  await assert.rejects(() => withChromeBuiltInSession(async () => {
    throw new Error("boom");
  }, { runtime }), /boom/);

  assert.equal(destroyed, 2);
});

test("testChromeBuiltInProvider validates one-tab response", async () => {
  const runtime = {
    LanguageModel: {
      availability: async () => "available",
      create: async () => ({
        async prompt() {
          return JSON.stringify({
            groups: [{ name: "Example", color: "blue", tabIds: [1], confidence: 1 }],
            ungroupedTabIds: [],
            warnings: []
          });
        },
        destroy() {}
      })
    }
  };

  assert.equal(await testChromeBuiltInProvider({ runtime }), true);
});
