const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createProactiveMessagesEnabledStore } = require("../src/core/proactive-messages-enabled-store");
const { createEventOpportunityPoller } = require("../src/app/event-opportunity-poller");
const { createSystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { createEventOpportunityStateStore } = require("../src/core/event-opportunity-state-store");
const { buildApp } = require("./helpers/app-test-config");

test("proactive master is fail-safe by default and persists across store instances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-gate-test-"));
  const config = { proactiveMessagesEnabledFile: path.join(dir, "enabled.json") };
  const first = createProactiveMessagesEnabledStore(config);

  assert.equal(first.isEnabled(), false);
  assert.deepEqual(first.setEnabled(true), { enabled: true });
  assert.equal(createProactiveMessagesEnabledStore(config).isEnabled(), true);
  assert.deepEqual(first.setEnabled(false), { enabled: false });
  assert.equal(createProactiveMessagesEnabledStore(config).isEnabled(), false);
});

test("disabled event poller never reads observations or queues an opportunity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-poller-gate-test-"));
  const queueStore = createSystemMessageQueueStore({ systemMessageQueueFile: path.join(dir, "queue.json") });
  const stateStore = createEventOpportunityStateStore({ eventOpportunityStateFile: path.join(dir, "state.json") });
  let observations = 0;
  const poller = createEventOpportunityPoller({
    queueStore,
    stateStore,
    buildObservationBundle: async () => {
      observations += 1;
      return { currentState: {}, openLoops: ["should never be read"] };
    },
    intervalMs: 1000,
    longSilenceMs: 1,
    isEnabled: () => false,
  });

  assert.deepEqual(await poller.tick(), { queued: false, reason: "disabled" });
  assert.equal(observations, 0);
  assert.deepEqual(queueStore.load(), { messages: [] });
});

test("argv and environment cannot bypass the disabled master, and old proactive queue items are cleared", async () => {
  const app = buildApp({ allowedSenderId: "user1", argv: ["--checkin"], proactiveMessagesEnabled: false });
  const state = app.systemMessageQueueStore.load();
  app.systemMessageQueueStore.save(app.systemMessageQueueStore.enqueue(state, {
    id: "old-event",
    source: "event_opportunity",
    createdAt: new Date().toISOString(),
  }));

  const previous = process.env.CYBERBOSS_CHECKIN;
  process.env.CYBERBOSS_CHECKIN = "1";
  try {
    assert.equal(app.startWithCheckin(), false);
  } finally {
    if (previous === undefined) delete process.env.CYBERBOSS_CHECKIN;
    else process.env.CYBERBOSS_CHECKIN = previous;
  }

  assert.deepEqual(app.systemMessageQueueStore.load(), { messages: [] });
  let runtimeCalls = 0;
  let sends = 0;
  app.runtimeAdapter.sendSingleTurn = async () => { runtimeCalls += 1; };
  app.channelAdapter.sendText = async () => { sends += 1; };
  const result = await app.runProactiveDrainTick();
  assert.equal(result.reason, "empty");
  assert.equal(runtimeCalls, 0);
  assert.equal(sends, 0);
});

test("turning the master off clears proactive records but retains user reminders", () => {
  const app = buildApp({ allowedSenderId: "user1", proactiveMessagesEnabled: false });
  let state = app.systemMessageQueueStore.load();
  state = app.systemMessageQueueStore.enqueue(state, {
    id: "reminder-1",
    source: "reminder",
    createdAt: new Date().toISOString(),
  });
  state = app.systemMessageQueueStore.enqueue(state, {
    id: "location-1",
    source: "location",
    createdAt: new Date().toISOString(),
  });
  app.systemMessageQueueStore.save(state);

  app.setProactiveMessagesEnabled(false);

  assert.deepEqual(app.systemMessageQueueStore.load().messages.map(({ id, source }) => ({ id, source })), [
    { id: "reminder-1", source: "reminder" },
  ]);
});
