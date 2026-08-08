const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createEventOpportunityPoller } = require("../src/app/event-opportunity-poller");
const { createSystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { createEventOpportunityStateStore } = require("../src/core/event-opportunity-state-store");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempStores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-eo-poller-test-"));
  const queueStore = createSystemMessageQueueStore({ systemMessageQueueFile: path.join(dir, "queue.json") });
  const stateStore = createEventOpportunityStateStore({ eventOpportunityStateFile: path.join(dir, "eo-state.json") });
  return { queueStore, stateStore };
}

function baseBundle() {
  return {
    currentState: { lastUserMessageAt: new Date().toISOString() },
    openLoops: [],
    companionSegments: [],
    taskerSnapshot: { activity: null, health: null },
  };
}

test("tick(): first-ever tick establishes a baseline and never enqueues", async () => {
  const { queueStore, stateStore } = tempStores();
  const poller = createEventOpportunityPoller({
    queueStore,
    stateStore,
    buildObservationBundle: async () => baseBundle(),
    intervalMs: 1000,
    cooldownMs: 1000,
    longSilenceMs: 6 * 60 * 60_000,
  });

  await poller.tick();

  assert.equal(queueStore.load().messages.length, 0);
  assert.ok(stateStore.load().snapshot);
});

test("tick(): enqueues source=event_opportunity when a real delta is observed", async () => {
  const { queueStore, stateStore } = tempStores();
  let call = 0;
  const poller = createEventOpportunityPoller({
    queueStore,
    stateStore,
    buildObservationBundle: async () => {
      call += 1;
      return call === 1
        ? baseBundle()
        : { ...baseBundle(), openLoops: ["new loop"] };
    },
    intervalMs: 1000,
    cooldownMs: 1000,
    longSilenceMs: 6 * 60 * 60_000,
  });

  await poller.tick(); // baseline
  await poller.tick(); // delta

  const state = queueStore.load();
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].source, "event_opportunity");
});

test("tick(): skips (and never calls buildObservationBundle) when a message is already pending", async () => {
  const { queueStore, stateStore } = tempStores();
  queueStore.save(queueStore.enqueue(queueStore.load(), {
    id: "existing", source: "stochastic_pulse", createdAt: new Date().toISOString(),
  }));

  let buildCalls = 0;
  const poller = createEventOpportunityPoller({
    queueStore,
    stateStore,
    buildObservationBundle: async () => { buildCalls += 1; return baseBundle(); },
    intervalMs: 1000,
    cooldownMs: 1000,
    longSilenceMs: 6 * 60 * 60_000,
  });

  await poller.tick();

  assert.equal(buildCalls, 0);
  assert.equal(queueStore.load().messages.length, 1);
});

test("tick(): logs and does not throw when buildObservationBundle rejects", async () => {
  const { queueStore, stateStore } = tempStores();
  const logs = [];
  const poller = createEventOpportunityPoller({
    queueStore,
    stateStore,
    buildObservationBundle: async () => { throw new Error("boom"); },
    intervalMs: 1000,
    cooldownMs: 1000,
    longSilenceMs: 6 * 60 * 60_000,
    onLog: (msg) => logs.push(msg),
  });

  await poller.tick();

  assert.ok(logs.some((l) => l.includes("tick failed") && l.includes("boom")));
  assert.equal(queueStore.load().messages.length, 0);
});

test("start() reschedules on the configured interval and stop() halts it", async () => {
  const { queueStore, stateStore } = tempStores();
  let ticks = 0;
  const poller = createEventOpportunityPoller({
    queueStore,
    stateStore,
    buildObservationBundle: async () => {
      ticks += 1;
      return baseBundle();
    },
    intervalMs: 20,
    cooldownMs: 1000,
    longSilenceMs: 6 * 60 * 60_000,
    onLog: () => {},
  });
  poller.start();
  await sleep(100);
  poller.stop();

  assert.ok(ticks >= 2, `应该在约100ms内(间隔20ms)触发至少2次，实际 ${ticks} 次`);
});
