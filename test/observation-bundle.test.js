const test = require("node:test");
const assert = require("node:assert/strict");

const { createObservationBundleBuilder } = require("../src/core/observation-bundle");

function fakeCurrentStateStore({ state, loops }) {
  return {
    load: () => state,
    openLoops: () => loops,
  };
}

function fakeMemoryStore({ core }) {
  return {
    load: () => ({}),
    selectForInjection: () => ({ core, contextual: [] }),
  };
}

test("build() assembles state/loops/memory locally and snapshot/segments remotely", async () => {
  const builder = createObservationBundleBuilder({
    currentStateStore: fakeCurrentStateStore({
      state: { currentActivity: "写代码", recentMood: "专注", lastUserMessageAt: "t1", lastAgentMessageAt: "t2" },
      loops: [{ id: "l1", summary: "答应帮她订生日蛋糕" }],
    }),
    memoryStore: fakeMemoryStore({ core: [{ fact: "喜欢薄荷绿" }] }),
    taskerSnapshotClient: { getSnapshot: async () => ({ health: { latest_hr: 71 }, activity: null }) },
    companionObservationClient: { getRecentSegments: async () => [{ start_ts: "a", end_ts: "b" }] },
  });

  const bundle = await builder.build();

  assert.equal(bundle.currentState.currentActivity, "写代码");
  assert.deepEqual(bundle.openLoops, ["答应帮她订生日蛋糕"]);
  assert.deepEqual(bundle.coreMemories, ["喜欢薄荷绿"]);
  assert.deepEqual(bundle.taskerSnapshot, { health: { latest_hr: 71 }, activity: null });
  assert.deepEqual(bundle.companionSegments, [{ start_ts: "a", end_ts: "b" }]);
  assert.ok(bundle.builtAt);
});

test("build() degrades a failing remote source to an {error} marker instead of throwing", async () => {
  const builder = createObservationBundleBuilder({
    currentStateStore: fakeCurrentStateStore({ state: {}, loops: [] }),
    memoryStore: fakeMemoryStore({ core: [] }),
    taskerSnapshotClient: { getSnapshot: async () => { throw new Error("tasker down"); } },
    companionObservationClient: { getRecentSegments: async () => [{ start_ts: "a" }] },
  });

  const bundle = await builder.build();

  assert.deepEqual(bundle.taskerSnapshot, { error: "tasker down" });
  assert.deepEqual(bundle.companionSegments, [{ start_ts: "a" }]);
});

test("build() degrades both remote sources independently when both fail", async () => {
  const builder = createObservationBundleBuilder({
    currentStateStore: fakeCurrentStateStore({ state: {}, loops: [] }),
    memoryStore: fakeMemoryStore({ core: [] }),
    taskerSnapshotClient: { getSnapshot: async () => { throw new Error("a"); } },
    companionObservationClient: { getRecentSegments: async () => { throw new Error("b"); } },
  });

  const bundle = await builder.build();

  assert.deepEqual(bundle.taskerSnapshot, { error: "a" });
  assert.deepEqual(bundle.companionSegments, { error: "b" });
});
