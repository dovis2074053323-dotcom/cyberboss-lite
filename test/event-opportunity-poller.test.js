const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createEventOpportunityPoller } = require("../src/app/event-opportunity-poller");
const { createSystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { createEventOpportunityStateStore } = require("../src/core/event-opportunity-state-store");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

function pollerFor({ buildObservationBundle, ...overrides }) {
  const stores = tempStores();
  return {
    ...stores,
    poller: createEventOpportunityPoller({
      queueStore: stores.queueStore,
      stateStore: stores.stateStore,
      buildObservationBundle,
      intervalMs: 1000,
      longSilenceMs: 6 * 60 * 60_000,
      ...overrides,
    }),
  };
}

test("first-ever tick establishes a baseline and never enqueues", async () => {
  const { poller, queueStore, stateStore } = pollerFor({ buildObservationBundle: async () => baseBundle() });
  await poller.tick();
  assert.equal(queueStore.load().messages.length, 0);
  assert.ok(stateStore.load().snapshot);
  assert.deepEqual(stateStore.load().evidence, []);
});

test("candidate queues without a frozen observation bundle", async () => {
  let call = 0;
  const { poller, queueStore } = pollerFor({
    buildObservationBundle: async () => {
      call += 1;
      return call === 1 ? baseBundle() : { ...baseBundle(), openLoops: ["new loop"] };
    },
  });
  await poller.tick();
  await poller.tick();
  const message = queueStore.load().messages[0];
  assert.equal(message.source, "event_opportunity");
  assert.deepEqual(message.reasons, ["open_loop_change"]);
  assert.equal("bundle" in message, false);
  assert.equal(message.evidenceScore, 3);
});

test("pending queue does not create a second item, but observation/evidence still advances", async () => {
  const { queueStore, stateStore, poller } = pollerFor({
    buildObservationBundle: async () => ({ ...baseBundle(), openLoops: ["loop"] }),
  });
  queueStore.save(queueStore.enqueue(queueStore.load(), {
    id: "existing", source: "event_opportunity", createdAt: new Date().toISOString(),
  }));
  let buildCalls = 0;
  poller.stop();
  const polling = createEventOpportunityPoller({
    queueStore,
    stateStore,
    buildObservationBundle: async () => { buildCalls += 1; return { ...baseBundle(), openLoops: ["loop"] }; },
    intervalMs: 1000,
    longSilenceMs: 6 * 60 * 60_000,
  });
  await polling.tick();
  assert.equal(buildCalls, 1);
  assert.equal(queueStore.load().messages.length, 1);
});

test("candidate stays local when optional gate reserves the remaining mandatory budget", async () => {
  let call = 0;
  const { poller, queueStore, stateStore } = pollerFor({
    buildObservationBundle: async () => {
      call += 1;
      return call === 1 ? baseBundle() : { ...baseBundle(), openLoops: ["loop"] };
    },
    canQueueOptional: () => ({ allowed: false, reason: "mandatory_budget_reserved" }),
  });
  await poller.tick();
  await poller.tick();
  assert.equal(queueStore.load().messages.length, 0);
  assert.equal(stateStore.load().candidate.evidenceScore, 3);
});

test("build failure is logged and does not enqueue", async () => {
  const logs = [];
  const { poller, queueStore } = pollerFor({
    buildObservationBundle: async () => { throw new Error("boom"); },
    onLog: (message) => logs.push(message),
  });
  await poller.tick();
  assert.ok(logs.some((message) => message.includes("tick failed") && message.includes("boom")));
  assert.equal(queueStore.load().messages.length, 0);
});

test("start() polls at the configured interval and stop() halts it", async () => {
  let ticks = 0;
  const { poller } = pollerFor({ intervalMs: 20, buildObservationBundle: async () => { ticks += 1; return baseBundle(); } });
  poller.start();
  await sleep(100);
  poller.stop();
  assert.ok(ticks >= 2, `expected at least two five-minute-poll simulations, got ${ticks}`);
});
