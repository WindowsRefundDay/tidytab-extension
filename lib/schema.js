export const GROUP_COLORS = [
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
  "cyan",
  "grey"
];

export const SORT_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          color: {
            type: "string",
            enum: GROUP_COLORS
          },
          tabIds: {
            type: "array",
            items: { type: "number" }
          },
          confidence: { type: "number" }
        },
        required: ["name", "color", "tabIds", "confidence"]
      }
    },
    ungroupedTabIds: {
      type: "array",
      items: { type: "number" }
    },
    warnings: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["groups", "ungroupedTabIds", "warnings"]
};

export function extractJsonObject(value) {
  if (value && typeof value === "object") {
    return value;
  }

  if (typeof value !== "string") {
    throw new Error("AI response was not JSON.");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("AI response was empty.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1]);
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error("AI response did not contain a JSON object.");
  }
}

export function normalizeColor(color, index = 0) {
  return GROUP_COLORS.includes(color) ? color : GROUP_COLORS[index % GROUP_COLORS.length];
}

export function sanitizeGroupName(name, fallback) {
  const cleaned = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || fallback;
}

export function validateSortPlan(rawPlan, tabs, options = {}) {
  const minConfidence = options.minConfidence ?? 0.45;
  const plan = extractJsonObject(rawPlan);
  const tabIdSet = new Set(tabs.map((tab) => tab.id).filter((id) => Number.isFinite(id)));
  const seen = new Set();
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.filter(Boolean).map(String) : [];

  if (!Array.isArray(plan.groups)) {
    return { ok: false, reason: "AI plan did not include groups.", warnings };
  }

  const groups = [];
  for (let i = 0; i < plan.groups.length; i += 1) {
    const group = plan.groups[i];
    if (!group || typeof group !== "object" || !Array.isArray(group.tabIds)) {
      continue;
    }

    const tabIds = [];
    for (const id of group.tabIds) {
      if (Number.isFinite(id) && tabIdSet.has(id) && !seen.has(id)) {
        seen.add(id);
        tabIds.push(id);
      }
    }

    if (tabIds.length === 0) {
      continue;
    }

    const confidence = Number.isFinite(group.confidence) ? Number(group.confidence) : 0;
    if (confidence < minConfidence) {
      return {
        ok: false,
        reason: `AI confidence for "${group.name || "group"}" was too low.`,
        warnings
      };
    }

    groups.push({
      name: sanitizeGroupName(group.name, `Group ${groups.length + 1}`),
      color: normalizeColor(group.color, groups.length),
      tabIds,
      confidence
    });
  }

  if (groups.length === 0) {
    return { ok: false, reason: "AI plan did not assign any tabs.", warnings };
  }

  const ungroupedTabIds = [];
  const rawUngrouped = Array.isArray(plan.ungroupedTabIds) ? plan.ungroupedTabIds : [];
  for (const id of rawUngrouped) {
    if (Number.isFinite(id) && tabIdSet.has(id) && !seen.has(id)) {
      seen.add(id);
      ungroupedTabIds.push(id);
    }
  }

  for (const tab of tabs) {
    if (Number.isFinite(tab.id) && !seen.has(tab.id)) {
      ungroupedTabIds.push(tab.id);
    }
  }

  return {
    ok: true,
    plan: {
      groups,
      ungroupedTabIds,
      warnings
    }
  };
}
