import test from "node:test";
import assert from "node:assert/strict";

import { createUndoSnapshot, groupRestorePlan, LAST_SORT_SNAPSHOT_KEY, tabsToRestore } from "../lib/undo.js";

test("createUndoSnapshot captures order, pinned state, and group metadata", () => {
  const snapshot = createUndoSnapshot(
    [
      { id: 2, index: 1, pinned: false, groupId: 7, windowId: 10 },
      { id: 1, index: 0, pinned: true, groupId: -1, windowId: 10 }
    ],
    [{ id: 7, title: "Work", color: "blue", collapsed: true }],
    123
  );

  assert.equal(LAST_SORT_SNAPSHOT_KEY, "aiTabSorterLastSortSnapshot");
  assert.equal(snapshot.windowId, 10);
  assert.deepEqual(
    snapshot.tabs.map((tab) => tab.id),
    [1, 2]
  );
  assert.equal(snapshot.tabs[0].pinned, true);
  assert.equal(snapshot.groups[0].title, "Work");
});

test("tabsToRestore ignores tabs closed after the snapshot", () => {
  const snapshot = { tabs: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(tabsToRestore(snapshot, [{ id: 2 }]), [{ id: 2 }]);
});

test("groupRestorePlan separates grouped and ungrouped tabs", () => {
  const snapshot = {
    tabs: [
      { id: 1, pinned: false, groupId: null },
      { id: 2, pinned: false, groupId: 7 },
      { id: 3, pinned: true, groupId: 7 }
    ],
    groups: [{ id: 7, title: "Work", color: "green", collapsed: false }]
  };

  const plan = groupRestorePlan(snapshot, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(plan.orderedTabIds, [1, 2]);
  assert.deepEqual(plan.missingTabIds, [3]);
  assert.deepEqual(plan.ungroupedTabIds, [1]);
  assert.deepEqual(plan.groups[0].tabIds, [2]);
  assert.equal(plan.groups[0].metadata.title, "Work");
});
