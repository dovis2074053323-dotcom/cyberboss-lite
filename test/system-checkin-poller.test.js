const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSystemCheckinPoller, pickRandomDelayMs } = require("../src/app/system-checkin-poller");
const { createSystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { createCheckinConfigStore } = require("../src/core/checkin-config-store");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempStores(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-poller-test-"));
  const queueStore = createSystemMessageQueueStore({ systemMessageQueueFile: path.join(dir, "queue.json") });
  const checkinConfigStore = createCheckinConfigStore({
    checkinConfigFile: path.join(dir, "checkin-config.json"),
    checkinMinIntervalMs: 20,
    checkinMaxIntervalMs: 20,
    ...overrides,
  });
  return { queueStore, checkinConfigStore };
}

test("pickRandomDelayMs stays within [min, max] and returns min when they're equal", () => {
  for (let i = 0; i < 20; i++) {
    const delay = pickRandomDelayMs(100, 200);
    assert.ok(delay >= 100 && delay <= 200, delay);
  }
  assert.equal(pickRandomDelayMs(50, 50), 50);
  assert.equal(pickRandomDelayMs(50, 10), 50); // inverted range: falls back to min
});

test("tick() enqueues a bundle from buildObservationBundle when the queue is empty", async () => {
  const { queueStore, checkinConfigStore } = tempStores();
  let buildCalls = 0;
  const poller = createSystemCheckinPoller({
    queueStore,
    checkinConfigStore,
    buildObservationBundle: async () => {
      buildCalls += 1;
      return { openLoops: ["测试loop"] };
    },
  });

  await poller.tick();

  assert.equal(buildCalls, 1);
  const state = queueStore.load();
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].source, "stochastic_pulse");
  assert.deepEqual(state.messages[0].bundle, { openLoops: ["测试loop"] });
});

test("tick() skips (and never calls buildObservationBundle) when a message is already pending", async () => {
  const { queueStore, checkinConfigStore } = tempStores();
  queueStore.save(queueStore.enqueue(queueStore.load(), {
    id: "existing", source: "stochastic_pulse", createdAt: new Date().toISOString(),
  }));

  let buildCalls = 0;
  const poller = createSystemCheckinPoller({
    queueStore,
    checkinConfigStore,
    buildObservationBundle: async () => { buildCalls += 1; return {}; },
  });

  await poller.tick();

  assert.equal(buildCalls, 0);
  assert.equal(queueStore.load().messages.length, 1); // still just the pre-existing one
});

test("tick() logs and does not throw when buildObservationBundle rejects", async () => {
  const { queueStore, checkinConfigStore } = tempStores();
  const logs = [];
  const poller = createSystemCheckinPoller({
    queueStore,
    checkinConfigStore,
    buildObservationBundle: async () => { throw new Error("boom"); },
    onLog: (msg) => logs.push(msg),
  });

  await poller.tick();

  assert.ok(logs.some((l) => l.includes("tick failed") && l.includes("boom")));
  assert.equal(queueStore.load().messages.length, 0);
});

test("start() reschedules on the configured interval and stop() halts it", async () => {
  const { queueStore, checkinConfigStore } = tempStores({ checkinMinIntervalMs: 20, checkinMaxIntervalMs: 20 });
  let ticks = 0;
  const poller = createSystemCheckinPoller({
    queueStore,
    checkinConfigStore,
    // Each tick's own enqueue leaves a pending message, so subsequent ticks
    // short-circuit at hasPending — this test only needs to prove
    // "the scheduler itself keeps firing", not queue draining (that's task
    // #14's job), so drain the queue on every call to let ticks keep landing.
    buildObservationBundle: async () => {
      ticks += 1;
      return {};
    },
    onLog: () => {},
  });
  poller.start();
  for (let i = 0; i < 4; i++) {
    await sleep(25);
    queueStore.save(queueStore.drainAll(queueStore.load()).state);
  }
  poller.stop();

  assert.ok(ticks >= 2, `应该在约100ms内(间隔20ms)触发至少2次，实际 ${ticks} 次`);
});
