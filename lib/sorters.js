import { GROUP_COLORS, validateSortPlan } from "./schema.js";

const DEFAULT_AI_PHASE_TIMEOUT_MS = 60000;

export const SORT_MODES = {
  TITLE: "title",
  SMART: "smart",
  AGENTIC: "agentic"
};

export function getDomain(url) {
  try {
    const parsed = new URL(url || "");
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Browser Pages";
    }
    return parsed.hostname.replace(/^www\./, "") || "Untitled";
  } catch {
    return "Untitled";
  }
}

export function normalizeTab(tab) {
  return {
    id: tab.id,
    title: tab.title || "Untitled",
    url: tab.url || "",
    domain: getDomain(tab.url),
    snippet: tab.snippet || "",
    history: tab.history || undefined
  };
}

export function titleSortPlan(tabs) {
  const grouped = new Map();

  for (const tab of tabs.map(normalizeTab)) {
    const key = tab.domain;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(tab);
  }

  const groups = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([domain, groupTabs], index) => ({
      name: domain,
      color: GROUP_COLORS[index % GROUP_COLORS.length],
      tabIds: groupTabs
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
        .map((tab) => tab.id),
      confidence: 1
    }));

  return {
    groups,
    ungroupedTabIds: [],
    warnings: []
  };
}

function tabListForPrompt(tabs) {
  return tabs.map((tab) => {
    const normalized = normalizeTab(tab);
    return {
      id: normalized.id,
      title: normalized.title,
      url: normalized.url,
      domain: normalized.domain,
      snippet: normalized.snippet || undefined,
      history: normalized.history || undefined
    };
  });
}

export function createSmartSortPrompt(tabs) {
  return [
    "Sort these browser tabs into practical Chrome tab groups using a trace-first reading of the user's work.",
    "Infer workflows from page title, URL, page snippet, opener tab, visit timing, transition type, referrer visit IDs, and neighboring current tabs.",
    "Do not group pages just because they share the same domain. Split same-site pages when their trace, task, or provenance differs.",
    "Do not overfit to history either: use trace data to infer the user's task flow, then group by the resulting purpose.",
    "Order tabs inside each group in the likely reading/work sequence when trace timing or referrer evidence makes that sequence clear.",
    "Return every tab ID exactly once inside a group. Keep ungroupedTabIds as an empty array.",
    "Prefer 2-8 groups unless the input is very small.",
    "Tabs:",
    JSON.stringify(tabListForPrompt(tabs), null, 2)
  ].join("\n");
}

export function createAgenticDiscoveryPrompt(tabs) {
  return [
    "Analyze these browser tabs and infer the user's active workflows before proposing groups.",
    "Build a mental trace graph from opener tabs, visit timing, transitions, referrer visit IDs, nearby history, page snippets, titles, and URLs.",
    "Focus on task intent and provenance, not only domains. Same-domain tabs may belong to different groups when their trace differs.",
    "Include confidence for each proposed cluster.",
    "Return the final answer as the required JSON sort plan.",
    "Tabs:",
    JSON.stringify(tabListForPrompt(tabs), null, 2)
  ].join("\n");
}

export function createAgenticFinalizePrompt(tabs, firstPassPlan) {
  return [
    "Refine this draft tab grouping.",
    "Merge weak or overlapping groups, normalize names, and order tabs naturally for a Chrome window.",
    "Use trace evidence to split same-domain tabs that came from different workstreams and to order each group by likely workflow sequence.",
    "Return every current tab ID exactly once inside a group. Keep ungroupedTabIds as an empty array.",
    "Current tabs:",
    JSON.stringify(tabListForPrompt(tabs), null, 2),
    "Draft grouping:",
    JSON.stringify(firstPassPlan, null, 2)
  ].join("\n");
}

export async function aiSortPlan(tabs, mode, callAi, options = {}) {
  const phaseTimeoutMs = options.phaseTimeoutMs ?? DEFAULT_AI_PHASE_TIMEOUT_MS;

  if (mode === SORT_MODES.AGENTIC) {
    const firstPass = await callAiPhase(
      callAi,
      createAgenticDiscoveryPrompt(tabs),
      { phase: "agentic-discovery" },
      phaseTimeoutMs
    );
    const firstValidation = validateSortPlan(firstPass, tabs, { minConfidence: 0.25 });
    const draft = firstValidation.ok ? firstValidation.plan : firstPass;

    try {
      const finalPass = await callAiPhase(
        callAi,
        createAgenticFinalizePrompt(tabs, draft),
        { phase: "agentic-finalize" },
        options.agenticFinalizeTimeoutMs ?? phaseTimeoutMs
      );
      const finalValidation = validateSortPlan(finalPass, tabs);
      if (finalValidation.ok || !firstValidation.ok) {
        return finalValidation;
      }
      return withPlanWarning(
        firstValidation,
        `AI phase 2 failed validation: ${finalValidation.reason || "unknown reason"}. Used the phase 1 draft instead.`
      );
    } catch (error) {
      if (!firstValidation.ok) {
        throw error;
      }
      return withPlanWarning(
        firstValidation,
        `AI phase 2 did not finish: ${error.message || String(error)}. Used the phase 1 draft instead.`
      );
    }
  }

  const smartPlan = await callAiPhase(
    callAi,
    createSmartSortPrompt(tabs),
    { phase: "smart-sort" },
    phaseTimeoutMs
  );
  return validateSortPlan(smartPlan, tabs);
}

async function callAiPhase(callAi, prompt, meta, timeoutMs) {
  const request = Promise.resolve().then(() => callAi(prompt, meta));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return request;
  }

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${meta.phase} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
  });

  return Promise.race([request, timeout]).finally(() => clearTimeout(timeoutId));
}

function withPlanWarning(validation, warning) {
  return {
    ok: true,
    plan: {
      ...validation.plan,
      warnings: [...(validation.plan.warnings || []), warning]
    }
  };
}

export function planOrFallback(validation, tabs) {
  if (validation.ok) {
    return groupAllTabs(validation.plan, tabs);
  }

  const fallback = titleSortPlan(tabs);
  fallback.warnings.push(validation.reason || "AI sort failed; used title sort instead.");
  return fallback;
}

export function groupAllTabs(plan, tabs) {
  const groups = (plan.groups || []).map((group) => ({
    ...group,
    tabIds: [...group.tabIds]
  }));
  const groupedIds = new Set(groups.flatMap((group) => group.tabIds));
  const leftovers = new Set((plan.ungroupedTabIds || []).filter((id) => !groupedIds.has(id)));

  for (const tab of tabs) {
    if (Number.isFinite(tab.id) && !groupedIds.has(tab.id)) {
      leftovers.add(tab.id);
    }
  }

  const orderedLeftovers = tabs.map((tab) => tab.id).filter((id) => leftovers.has(id));
  if (!orderedLeftovers.length) {
    return {
      ...plan,
      groups,
      ungroupedTabIds: []
    };
  }

  groups.push({
    name: "Other Tabs",
    color: GROUP_COLORS[groups.length % GROUP_COLORS.length],
    tabIds: orderedLeftovers,
    confidence: 1
  });

  return {
    ...plan,
    groups,
    ungroupedTabIds: [],
    warnings: [
      ...(plan.warnings || []),
      `Grouped ${orderedLeftovers.length} tab${orderedLeftovers.length === 1 ? "" : "s"} that the AI left ungrouped.`
    ]
  };
}
