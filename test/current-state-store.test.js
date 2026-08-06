const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createCurrentStateStore } = require("../src/core/current-state-store");
const { StateCorruptionError } = require("../src/core/json-store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-state-test-"));
  return { currentStateFile: path.join(dir, "current-state.json"), dir };
}

test("load returns a fresh default state when no file exists yet", () => {
  const store = createCurrentStateStore(tempConfig());
  const state = store.load();
  assert.deepEqual(state, {
    currentActivity: null,
    expectedReturnAt: null,
    recentMood: null,
    lastUserMessageAt: null,
    lastAgentMessageAt: null,
    openLoops: [],
  });
});

test("save then load round-trips through an atomic write", () => {
  const config = tempConfig();
  const store = createCurrentStateStore(config);
  const state = store.applyPatch(store.load(), { currentActivity: "写代码" }, { lastUserMessageAt: "2026-08-06T12:00:00Z" });
  store.save(state);

  const reloaded = store.load();
  assert.equal(reloaded.currentActivity, "写代码");
  assert.equal(reloaded.lastUserMessageAt, "2026-08-06T12:00:00Z");

  const raw = fs.readFileSync(config.currentStateFile, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(parsed.updatedAt);
});

test("applyPatch only touches the 3 subjective fields from the model patch", () => {
  const store = createCurrentStateStore(tempConfig());
  const state = store.applyPatch(store.load(), {
    currentActivity: "开会",
    expectedReturnAt: "18:00",
    recentMood: "专注",
    lastUserMessageAt: "model-supplied-lie",
    lastAgentMessageAt: "model-supplied-lie",
  });
  assert.equal(state.currentActivity, "开会");
  assert.equal(state.expectedReturnAt, "18:00");
  assert.equal(state.recentMood, "专注");
  // System-owned timestamps are never taken from the model's statePatch.
  assert.equal(state.lastUserMessageAt, null);
  assert.equal(state.lastAgentMessageAt, null);
});

test("applyPatch sets system-owned timestamps only from the explicit event args", () => {
  const store = createCurrentStateStore(tempConfig());
  const state = store.applyPatch(store.load(), {}, {
    lastUserMessageAt: "2026-08-06T12:00:00Z",
    lastAgentMessageAt: "2026-08-06T12:00:05Z",
  });
  assert.equal(state.lastUserMessageAt, "2026-08-06T12:00:00Z");
  assert.equal(state.lastAgentMessageAt, "2026-08-06T12:00:05Z");
});

test("addLoop appends an open loop with a generated id", () => {
  const store = createCurrentStateStore(tempConfig());
  const state = store.addLoop(store.load(), { summary: "帮用户查一下航班", sourceQuote: "帮我查下航班" });
  assert.equal(state.openLoops.length, 1);
  assert.match(state.openLoops[0].id, /^loop_/);
  assert.equal(state.openLoops[0].status, "open");
  assert.equal(store.openLoops(state).length, 1);
});

test("resolveLoop marks only the matching open loop as resolved", () => {
  const store = createCurrentStateStore(tempConfig());
  let state = store.addLoop(store.load(), { summary: "a", sourceQuote: "a" });
  state = store.addLoop(state, { summary: "b", sourceQuote: "b" });
  const targetId = state.openLoops[0].id;
  state = store.resolveLoop(state, targetId);

  assert.equal(state.openLoops.find((loop) => loop.id === targetId).status, "resolved");
  assert.equal(store.openLoops(state).length, 1);
});

test("load fails closed on a corrupt file instead of silently resetting", () => {
  const config = tempConfig();
  fs.writeFileSync(config.currentStateFile, "{not valid json", "utf8");
  const store = createCurrentStateStore(config);
  assert.throws(() => store.load(), StateCorruptionError);
  // The corrupt file must still be on disk, untouched.
  assert.equal(fs.readFileSync(config.currentStateFile, "utf8"), "{not valid json");
});
