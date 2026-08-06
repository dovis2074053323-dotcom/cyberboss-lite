const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createCurrentStateStore } = require("../src/core/current-state-store");
const { createEpisodeStore } = require("../src/core/episode-store");
const { createMemoryStore } = require("../src/core/memory-store");
const { createIntentionsStore } = require("../src/core/intentions-store");
const { createTurnCoordinator } = require("../src/core/turn-coordinator");
const { EPISODE_SOFT_TOKEN_LIMIT, EPISODE_HARD_TOKEN_LIMIT } = require("../src/core/token-estimate");

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-coordinator-test-"));
  const config = {
    currentStateFile: path.join(dir, "current-state.json"),
    memoriesFile: path.join(dir, "memories.json"),
    intentionsFile: path.join(dir, "intentions.json"),
    episodeCurrentFile: path.join(dir, "episodes", "current.json"),
    episodeArchiveDir: path.join(dir, "episodes", "archive"),
  };
  const stores = {
    currentStateStore: createCurrentStateStore(config),
    episodeStore: createEpisodeStore(config),
    memoryStore: createMemoryStore(config),
    intentionsStore: createIntentionsStore(config),
  };
  const coordinator = createTurnCoordinator(stores);
  return { config, stores, coordinator };
}

function validResult(overrides = {}) {
  return {
    reply: "好的",
    statePatch: {},
    memory: { remember: [], forget: [] },
    loops: { add: [], resolve: [] },
    intentions: { create: [], resolve: [] },
    handoff: null,
    ...overrides,
  };
}

test("a valid turn with a successful send applies statePatch, memory, loops, intentions and episode append", async () => {
  const { stores, coordinator } = makeHarness();
  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T10:00:00.000Z", receivedAtLocal: "10:00", mergedText: "我喜欢猫",
  });

  const sent = [];
  const result = await coordinator.applyTurn({
    structuredResult: validResult({
      reply: "记住啦",
      statePatch: { currentActivity: "聊天" },
      memory: { remember: [{ category: "preference", fact: "喜欢猫", tier: "core", sourceQuote: "我喜欢猫" }], forget: [] },
      loops: { add: [{ summary: "查航班", sourceQuote: "我喜欢猫" }], resolve: [] },
    }),
    turnUserText: "我喜欢猫",
    receivedAtIso: "2026-08-06T10:00:00.000Z",
    sourceTurnId: "turn-1",
    prepared,
    sendReply: async (text) => { sent.push(text); return true; },
  });

  assert.equal(result.applied, true);
  assert.deepEqual(sent, ["记住啦"]);

  const state = stores.currentStateStore.load();
  assert.equal(state.currentActivity, "聊天");
  assert.equal(state.lastUserMessageAt, "2026-08-06T10:00:00.000Z");
  assert.ok(state.lastAgentMessageAt);
  assert.equal(state.openLoops.length, 1);

  const memoryState = stores.memoryStore.load();
  assert.equal(memoryState.memories.length, 1);

  const episode = stores.episodeStore.load();
  assert.deepEqual(episode.messages.map((m) => m.role), ["user", "assistant"]);
});

test("an invalid structured result applies nothing", async () => {
  const { stores, coordinator } = makeHarness();
  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T10:00:00.000Z", receivedAtLocal: "10:00", mergedText: "hi",
  });

  let sendCalled = false;
  const result = await coordinator.applyTurn({
    structuredResult: { reply: "hi", statePatch: {} }, // missing required fields
    turnUserText: "hi",
    receivedAtIso: "2026-08-06T10:00:00.000Z",
    prepared,
    sendReply: async () => { sendCalled = true; return true; },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "invalid_structured_result");
  assert.equal(sendCalled, false);
  const episode = stores.episodeStore.load();
  assert.equal(episode.messages.length, 0);
});

test("a WeChat send failure voids the whole turn: no state, memory, or episode changes", async () => {
  const { stores, coordinator } = makeHarness();
  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T10:00:00.000Z", receivedAtLocal: "10:00", mergedText: "我喜欢猫",
  });

  const result = await coordinator.applyTurn({
    structuredResult: validResult({
      reply: "记住啦",
      memory: { remember: [{ category: "preference", fact: "喜欢猫", tier: "core", sourceQuote: "我喜欢猫" }], forget: [] },
    }),
    turnUserText: "我喜欢猫",
    receivedAtIso: "2026-08-06T10:00:00.000Z",
    prepared,
    sendReply: async () => false,
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "send_failed");
  assert.equal(stores.memoryStore.load().memories.length, 0);
  assert.equal(stores.currentStateStore.load().lastAgentMessageAt, null);
  assert.equal(stores.episodeStore.load().messages.length, 0);
});

test("a silent reply (null) still applies state but never sets lastAgentMessageAt and never calls sendReply", async () => {
  const { stores, coordinator } = makeHarness();
  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T10:00:00.000Z", receivedAtLocal: "10:00", mergedText: "随便说说",
  });

  let sendCalled = false;
  const result = await coordinator.applyTurn({
    structuredResult: validResult({ reply: null, statePatch: { recentMood: "平静" } }),
    turnUserText: "随便说说",
    receivedAtIso: "2026-08-06T10:00:00.000Z",
    prepared,
    sendReply: async () => { sendCalled = true; return true; },
  });

  assert.equal(result.applied, true);
  assert.equal(sendCalled, false);
  const state = stores.currentStateStore.load();
  assert.equal(state.recentMood, "平静");
  assert.equal(state.lastAgentMessageAt, null);
  const episode = stores.episodeStore.load();
  assert.deepEqual(episode.messages.map((m) => m.role), ["user"]);
});

test("soft limit + a provided handoff triggers a full episode rollover", async () => {
  const { stores, coordinator } = makeHarness();
  let episode = stores.episodeStore.ensureCurrent("2026-08-06T09:00:00.000Z");
  episode = stores.episodeStore.appendMessage(episode, {
    // "字" is 3 UTF-8 bytes, so estimateTokens ~= character count; land
    // comfortably between soft(3500) and hard(5000).
    role: "user", text: "字".repeat(EPISODE_SOFT_TOKEN_LIMIT + 200), at: "2026-08-06T09:00:00.000Z",
  });
  stores.episodeStore.save(episode);
  const oldEpisodeId = episode.id;

  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T09:01:00.000Z", receivedAtLocal: "09:01", mergedText: "继续",
  });
  assert.equal(prepared.preTurnBudgetStatus, "soft");

  const result = await coordinator.applyTurn({
    structuredResult: validResult({
      reply: "好的",
      handoff: { summary: "概要", tone: "轻松", openLoops: [], carryForward: [] },
    }),
    turnUserText: "继续",
    receivedAtIso: "2026-08-06T09:01:00.000Z",
    prepared,
    sendReply: async () => true,
  });

  assert.equal(result.rolloverAction, "rollover");
  const fresh = stores.episodeStore.load();
  assert.notEqual(fresh.id, oldEpisodeId);
});

test("hard limit without a handoff trims to the last 4 turns instead of rolling over", async () => {
  const { stores, coordinator } = makeHarness();
  let episode = stores.episodeStore.ensureCurrent("2026-08-06T09:00:00.000Z");
  for (let i = 0; i < 6; i += 1) {
    episode = stores.episodeStore.appendMessage(episode, {
      role: "user", text: "字".repeat(1000), at: `2026-08-06T09:0${i}:00.000Z`,
    });
    episode = stores.episodeStore.appendMessage(episode, {
      role: "assistant", text: "字".repeat(1000), at: `2026-08-06T09:0${i}:01.000Z`,
    });
  }
  stores.episodeStore.save(episode);
  assert.ok(episode.estimatedTokens >= EPISODE_HARD_TOKEN_LIMIT);
  const sameEpisodeId = episode.id;

  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T09:10:00.000Z", receivedAtLocal: "09:10", mergedText: "继续",
  });
  assert.equal(prepared.preTurnBudgetStatus, "hard");

  const result = await coordinator.applyTurn({
    structuredResult: validResult({ reply: "好的" }),
    turnUserText: "继续",
    receivedAtIso: "2026-08-06T09:10:00.000Z",
    prepared,
    sendReply: async () => true,
  });

  assert.equal(result.rolloverAction, "trim");
  const trimmed = stores.episodeStore.load();
  assert.equal(trimmed.id, sameEpisodeId); // same episode, not a rollover
  assert.ok(trimmed.messages.length < episode.messages.length + 2);
});

test("a pending resume_topic shown this turn gets resolved after a successful apply", async () => {
  const { stores, coordinator } = makeHarness();
  let intentionsState = stores.intentionsStore.load();
  let intention;
  ({ state: intentionsState, intention } = stores.intentionsStore.create(intentionsState, {
    type: "resume_topic", reason: "还没聊完的话题", sourceQuote: "改天再聊",
  }, { nowIso: "2026-08-06T08:00:00.000Z" }));
  stores.intentionsStore.save(intentionsState);

  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T10:00:00.000Z", receivedAtLocal: "10:00", mergedText: "嗨",
  });
  assert.deepEqual(prepared.pendingResumeTopicIds, [intention.id]);
  // Spec §9 test 12: resume_topic must actually be injected into the very next
  // inbound turn's assembled context, not just tracked internally.
  assert.match(prepared.turnText, /还没聊完的话题/);

  await coordinator.applyTurn({
    structuredResult: validResult({ reply: "嗨，我们接着聊" }),
    turnUserText: "嗨",
    receivedAtIso: "2026-08-06T10:00:00.000Z",
    prepared,
    sendReply: async () => true,
  });

  const finalState = stores.intentionsStore.load();
  assert.equal(finalState.intentions.find((i) => i.id === intention.id).status, "resolved");
});

test("check_in intentions are cancelled during prepareTurn simply because a real message arrived", async () => {
  const { stores, coordinator } = makeHarness();
  let intentionsState = stores.intentionsStore.load();
  let intention;
  ({ state: intentionsState, intention } = stores.intentionsStore.create(intentionsState, {
    type: "check_in", reason: "面试关心", sourceQuote: "面试", dueAt: "2026-08-08T00:00:00.000Z",
  }, { nowIso: "2026-08-06T08:00:00.000Z" }));
  stores.intentionsStore.save(intentionsState);

  await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T10:00:00.000Z", receivedAtLocal: "10:00", mergedText: "嗨",
  });

  const finalState = stores.intentionsStore.load();
  assert.equal(finalState.intentions.find((i) => i.id === intention.id).status, "cancelled");
});

// Spec §9 test 3: a >=6h idle gap rolls the episode over exactly once, even
// across repeated turns — the second turn's own lastTurnAt is now recent (from
// the rollover), so it must not trigger a second rollover for the same gap.
test("a 6h+ idle gap rolls the episode over exactly once, not once per subsequent turn", async () => {
  const { config, stores, coordinator } = makeHarness();
  const original = stores.episodeStore.ensureCurrent("2026-08-06T00:00:00.000Z");
  const originalId = original.id;

  const firstPrepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T06:00:01.000Z", receivedAtLocal: "06:00", mergedText: "早",
  });
  await coordinator.applyTurn({
    structuredResult: validResult({ reply: "早呀" }),
    turnUserText: "早",
    receivedAtIso: "2026-08-06T06:00:01.000Z",
    prepared: firstPrepared,
    sendReply: async () => true,
  });
  const afterFirstRollover = stores.episodeStore.load();
  assert.notEqual(afterFirstRollover.id, originalId);
  const rolledOverId = afterFirstRollover.id;

  // A second turn arrives seconds later — nowhere near another 6h gap from the
  // rollover that just happened.
  const secondPrepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T06:00:05.000Z", receivedAtLocal: "06:00", mergedText: "在吗",
  });
  await coordinator.applyTurn({
    structuredResult: validResult({ reply: "在的" }),
    turnUserText: "在吗",
    receivedAtIso: "2026-08-06T06:00:05.000Z",
    prepared: secondPrepared,
    sendReply: async () => true,
  });

  assert.equal(stores.episodeStore.load().id, rolledOverId);
  const archivedFiles = fs.readdirSync(config.episodeArchiveDir);
  assert.equal(archivedFiles.length, 1);
});

// Spec §9 test 13: episode, memory, state, and intentions must all survive a
// process restart. Simulated here by dropping every in-memory store/
// coordinator reference and rebuilding fresh ones against the same config —
// there is no in-process cache to "accidentally" make this pass.
test("episode, memory, state, and intentions all recover after a simulated restart", async () => {
  const { config, stores, coordinator } = makeHarness();
  const prepared = await coordinator.prepareTurn({
    agentName: "test", receivedAtIso: "2026-08-06T10:00:00.000Z", receivedAtLocal: "10:00", mergedText: "我喜欢猫",
  });
  await coordinator.applyTurn({
    structuredResult: validResult({
      reply: "记住啦",
      statePatch: { currentActivity: "聊天" },
      memory: { remember: [{ category: "preference", fact: "喜欢猫", tier: "core", sourceQuote: "我喜欢猫" }], forget: [] },
      loops: { add: [{ summary: "查航班", sourceQuote: "我喜欢猫" }], resolve: [] },
      intentions: { create: [{ type: "resume_topic", reason: "还没聊完的话题", sourceQuote: "我喜欢猫" }], resolve: [] },
    }),
    turnUserText: "我喜欢猫",
    receivedAtIso: "2026-08-06T10:00:00.000Z",
    prepared,
    sendReply: async () => true,
  });

  // Fresh stores against the same config, as a restarted process would create.
  const freshCurrentStateStore = createCurrentStateStore(config);
  const freshEpisodeStore = createEpisodeStore(config);
  const freshMemoryStore = createMemoryStore(config);
  const freshIntentionsStore = createIntentionsStore(config);

  const state = freshCurrentStateStore.load();
  assert.equal(state.currentActivity, "聊天");
  assert.equal(state.openLoops.length, 1);

  const episode = freshEpisodeStore.load();
  assert.equal(episode.messages.length, 2);

  const memoryState = freshMemoryStore.load();
  assert.equal(memoryState.memories.length, 1);

  const intentionsState = freshIntentionsStore.load();
  assert.equal(intentionsState.intentions.length, 1);
  assert.equal(intentionsState.intentions[0].type, "resume_topic");
});
