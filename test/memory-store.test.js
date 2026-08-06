const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createMemoryStore, CORE_TIER_MAX, CONTEXTUAL_TIER_MAX } = require("../src/core/memory-store");
const { StateCorruptionError } = require("../src/core/json-store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-test-"));
  return { memoriesFile: path.join(dir, "memories.json") };
}

function candidate(overrides = {}) {
  return {
    category: "preference",
    fact: "喜欢猫",
    tier: "core",
    sourceQuote: "我喜欢猫",
    tags: ["猫"],
    ...overrides,
  };
}

test("remember creates a new active memory with system-owned fields", () => {
  const store = createMemoryStore(tempConfig());
  const { state, outcome, memory } = store.remember(store.load(), candidate(), { nowIso: "2026-08-06T10:00:00.000Z" });
  assert.equal(outcome, "created");
  assert.match(memory.id, /^mem_/);
  assert.equal(memory.confidence, "explicit");
  assert.equal(memory.status, "active");
  assert.equal(state.memories.length, 1);
});

test("remember merges an exact-normalized duplicate instead of adding a new record", () => {
  const store = createMemoryStore(tempConfig());
  let state = store.load();
  ({ state } = store.remember(state, candidate(), { nowIso: "2026-08-06T10:00:00.000Z" }));
  const before = state.memories[0].id;

  const result = store.remember(state, candidate({ fact: "  喜欢猫  ", tags: ["宠物"] }), { nowIso: "2026-08-06T11:00:00.000Z" });
  assert.equal(result.outcome, "merged");
  assert.equal(result.state.memories.length, 1);
  assert.equal(result.state.memories[0].id, before);
  assert.equal(result.state.memories[0].updatedAt, "2026-08-06T11:00:00.000Z");
  assert.deepEqual(result.state.memories[0].tags.sort(), ["宠物", "猫"]);
});

test("remember rejects a new core memory once the core tier is full", () => {
  const store = createMemoryStore(tempConfig());
  let state = store.load();
  for (let i = 0; i < CORE_TIER_MAX; i += 1) {
    ({ state } = store.remember(state, candidate({ fact: `事实${i}`, sourceQuote: `事实${i}` }), { nowIso: "2026-08-06T10:00:00.000Z" }));
  }
  assert.equal(state.memories.length, CORE_TIER_MAX);

  const result = store.remember(state, candidate({ fact: "多一条", sourceQuote: "多一条" }), { nowIso: "2026-08-06T10:00:00.000Z" });
  assert.equal(result.outcome, "rejected_tier_full");
  assert.equal(result.state.memories.length, CORE_TIER_MAX);
});

test("remember rejects a new contextual memory once the contextual tier is full", () => {
  const store = createMemoryStore(tempConfig());
  let state = store.load();
  for (let i = 0; i < CONTEXTUAL_TIER_MAX; i += 1) {
    ({ state } = store.remember(state, candidate({ tier: "contextual", fact: `事实${i}`, sourceQuote: `事实${i}` }), { nowIso: "2026-08-06T10:00:00.000Z" }));
  }
  const result = store.remember(state, candidate({ tier: "contextual", fact: "多一条", sourceQuote: "多一条" }), { nowIso: "2026-08-06T10:00:00.000Z" });
  assert.equal(result.outcome, "rejected_tier_full");
});

test("forget marks a matching active memory as superseded and is a no-op for unknown ids", () => {
  const store = createMemoryStore(tempConfig());
  let state = store.load();
  let memory;
  ({ state, memory } = store.remember(state, candidate(), { nowIso: "2026-08-06T10:00:00.000Z" }));

  const forgotten = store.forget(state, memory.id, { nowIso: "2026-08-07T10:00:00.000Z" });
  assert.equal(forgotten.matched, true);
  assert.equal(forgotten.state.memories[0].status, "superseded");
  assert.equal(forgotten.state.memories[0].updatedAt, "2026-08-07T10:00:00.000Z");

  const noop = store.forget(state, "mem_does_not_exist", { nowIso: "2026-08-07T10:00:00.000Z" });
  assert.equal(noop.matched, false);
});

test("purgeSuperseded removes superseded memories only after 30 days, never active ones", () => {
  const store = createMemoryStore(tempConfig());
  let state = store.load();
  let memory;
  ({ state, memory } = store.remember(state, candidate(), { nowIso: "2026-01-01T00:00:00.000Z" }));
  ({ state } = store.remember(state, candidate({ fact: "还活着", sourceQuote: "还活着" }), { nowIso: "2026-01-01T00:00:00.000Z" }));
  ({ state } = store.forget(state, memory.id, { nowIso: "2026-01-01T00:00:00.000Z" }));

  const nowMs = Date.parse("2026-01-20T00:00:00.000Z"); // 19 days later, still within 30
  const notPurgedYet = store.purgeSuperseded(state, nowMs);
  assert.equal(notPurgedYet.memories.length, 2);

  const afterThirtyOneDays = Date.parse("2026-02-02T00:00:00.000Z");
  const purged = store.purgeSuperseded(state, afterThirtyOneDays);
  assert.equal(purged.memories.length, 1);
  assert.equal(purged.memories[0].status, "active");
});

test("selectForInjection always includes all core memories and scores contextual ones", () => {
  const store = createMemoryStore(tempConfig());
  let state = store.load();
  ({ state } = store.remember(state, candidate({ tier: "core", fact: "核心事实", sourceQuote: "核心事实" }), { nowIso: "2026-08-06T10:00:00.000Z" }));
  ({ state } = store.remember(state, candidate({ tier: "contextual", tags: ["咖啡"], fact: "喜欢喝咖啡", sourceQuote: "喜欢喝咖啡" }), { nowIso: "2026-08-01T10:00:00.000Z" }));
  ({ state } = store.remember(state, candidate({ tier: "contextual", tags: ["登山"], fact: "喜欢爬山", sourceQuote: "喜欢爬山" }), { nowIso: "2026-01-01T10:00:00.000Z" }));

  const { core, contextual } = store.selectForInjection(state, {
    currentMessageText: "今天想喝咖啡",
    openLoopSummaries: [],
    nowMs: Date.parse("2026-08-06T12:00:00.000Z"),
  });
  assert.equal(core.length, 1);
  assert.equal(core[0].fact, "核心事实");
  assert.ok(contextual.length >= 1);
  assert.equal(contextual[0].fact, "喜欢喝咖啡");
});

test("load fails closed on a corrupt file instead of silently resetting", () => {
  const config = tempConfig();
  fs.writeFileSync(config.memoriesFile, "{broken", "utf8");
  const store = createMemoryStore(config);
  assert.throws(() => store.load(), StateCorruptionError);
});
