export const LAST_SORT_SNAPSHOT_KEY = "aiTabSorterLastSortSnapshot";

export function createUndoSnapshot(tabs, groups, now = Date.now()) {
  const groupMap = new Map((groups || []).map((group) => [group.id, group]));
  const orderedTabs = [...tabs].sort((a, b) => a.index - b.index);
  const groupIds = [...new Set(orderedTabs.map((tab) => tab.groupId).filter((id) => Number.isFinite(id) && id >= 0))];

  return {
    version: 1,
    createdAt: now,
    windowId: orderedTabs[0]?.windowId ?? null,
    tabs: orderedTabs.map((tab) => ({
      id: tab.id,
      index: tab.index,
      pinned: Boolean(tab.pinned),
      groupId: Number.isFinite(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null
    })),
    groups: groupIds.map((id) => {
      const group = groupMap.get(id) || {};
      return {
        id,
        title: group.title || "",
        color: group.color || "grey",
        collapsed: Boolean(group.collapsed)
      };
    })
  };
}

export function tabsToRestore(snapshot, currentTabs) {
  const currentIds = new Set((currentTabs || []).map((tab) => tab.id));
  return (snapshot?.tabs || []).filter((tab) => currentIds.has(tab.id));
}

export function groupRestorePlan(snapshot, currentTabs) {
  const restoreTabs = tabsToRestore(snapshot, currentTabs);
  const currentIds = new Set(restoreTabs.map((tab) => tab.id));
  const metadataByOriginalId = new Map((snapshot?.groups || []).map((group) => [group.id, group]));
  const grouped = new Map();
  const ungroupedTabIds = [];

  for (const tab of restoreTabs) {
    if (tab.groupId === null) {
      ungroupedTabIds.push(tab.id);
      continue;
    }
    if (!grouped.has(tab.groupId)) grouped.set(tab.groupId, []);
    grouped.get(tab.groupId).push(tab.id);
  }

  return {
    orderedTabIds: restoreTabs.map((tab) => tab.id),
    restoreTabs,
    missingTabIds: (snapshot?.tabs || []).map((tab) => tab.id).filter((id) => !currentIds.has(id)),
    ungroupedTabIds,
    groups: [...grouped.entries()].map(([originalGroupId, tabIds]) => ({
      originalGroupId,
      tabIds,
      metadata: metadataByOriginalId.get(originalGroupId) || {
        title: "",
        color: "grey",
        collapsed: false
      }
    }))
  };
}
