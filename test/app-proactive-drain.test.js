// Task #14: runProactiveDrainTick drains system-message-queue-store (populated
// by Stochastic Pulse / Event Opportunity, tested separately in
// test/system-checkin-poller.test.js and test/event-opportunity-poller.test.js)
// and runs exactly one real proactive Claude turn per queued message. These
// tests exercise it directly (not through the 60s Pulse timer) with a real
// host-lock (flock is available in this environment, same as
// test/host-lock.test.js) and stubbed runtime/channel adapters — no real
// Claude process or WeChat account involved.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApp } = require("./helpers/app-test-config");
const { acquireHostLock } = require("../src/core/host-lock");

function enqueueOne(app, overrides = {}) {
  const state = app.systemMessageQueueStore.load();
  const next = app.systemMessageQueueStore.enqueue(state, {
    id: "msg1",
    source: "stochastic_pulse",
    createdAt: new Date().toISOString(),
    bundle: { currentState: {}, openLoops: [], coreMemories: [] },
    ...overrides,
  });
  app.systemMessageQueueStore.save(next);
}

test("empty queue: returns reason=empty, never touches runtime or channel", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  let runtimeCalled = false;
  let sendCalled = false;
  app.runtimeAdapter.sendSingleTurn = async () => { runtimeCalled = true; return { structuredResult: {} }; };
  app.channelAdapter.sendText = async () => { sendCalled = true; };

  const result = await app.runProactiveDrainTick();

  assert.equal(result.drained, false);
  assert.equal(result.reason, "empty");
  assert.equal(runtimeCalled, false);
  assert.equal(sendCalled, false);
});

test("no allowedSenderId yet: skips before touching the lock, message stays queued", async () => {
  const app = buildApp(); // allowedSenderId defaults to ""
  enqueueOne(app);

  const result = await app.runProactiveDrainTick();

  assert.equal(result.drained, false);
  assert.equal(result.reason, "no_allowed_sender");
  assert.equal(app.systemMessageQueueStore.load().messages.length, 1, "消息不应该被消费掉");
});

test("lock busy: skips, message stays queued for the next tick", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);

  const holder = await acquireHostLock({ lockDir: app.config.hostLockDir, kind: "test_hold", timeoutMs: 0 });
  try {
    const result = await app.runProactiveDrainTick();
    assert.equal(result.drained, false);
    assert.equal(result.reason, "lock_busy");
    assert.equal(app.systemMessageQueueStore.load().messages.length, 1);
  } finally {
    await holder.release();
  }
});

test("send_message end to end: WeChat send called, keke_state pushed, lastAgentMessageAt updated, queue drained", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);

  const sent = [];
  const pushed = [];
  app.runtimeAdapter.sendSingleTurn = async ({ text, resultSchema }) => {
    assert.ok(text.includes("SYSTEM ACTION MODE"), "应该用 proactive-turn-builder 渲染的 prompt");
    assert.ok(resultSchema, "应该传入窄契约 schema，不是默认的 RESULT_JSON_SCHEMA");
    return { structuredResult: { action: "send_message", message: "在干嘛呀", reason: "quiet a while" } };
  };
  app.channelAdapter.sendText = async ({ userId, text }) => { sent.push({ userId, text }); };
  app.petStateClient.pushExpression = async (payload) => { pushed.push(payload); };

  const result = await app.runProactiveDrainTick();

  assert.equal(result.drained, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].action, "send_message");
  assert.equal(result.results[0].sent, true);
  assert.deepEqual(sent, [{ userId: "user1", text: "在干嘛呀" }]);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].expression, "alert");
  assert.equal(app.systemMessageQueueStore.load().messages.length, 0);

  const state = app.currentStateStore.load();
  assert.ok(state.lastAgentMessageAt, "lastAgentMessageAt 应该被更新");
});

test("need_context end to end: app.js pushes a real requestId via petStateClient, then polls companionObservationClient for the device's answer", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);

  let calls = 0;
  const prompts = [];
  app.runtimeAdapter.sendSingleTurn = async ({ text }) => {
    calls += 1;
    prompts.push(text);
    if (calls === 1) {
      return { structuredResult: { action: "need_context", message: null, reason: "not enough" } };
    }
    return { structuredResult: { action: "silent", message: null, reason: "still nothing after refresh" } };
  };
  let requestedId = null;
  app.petStateClient.requestContextSnapshot = async ({ requestId }) => { requestedId = requestId; };
  let fetchCalled = false;
  app.companionObservationClient.getContextSnapshot = async ({ requestId }) => {
    fetchCalled = true;
    assert.equal(requestId, requestedId, "轮询用的 requestId 应该和刚推送的是同一个");
    return { created_at: "2026-08-09T12:00:00Z", detail: { requestId, package: "com.android.chrome" } };
  };

  const result = await app.runProactiveDrainTick();

  assert.ok(requestedId, "应该真的推送了一个 requestId，不是老的被动重读");
  assert.equal(fetchCalled, true);
  assert.equal(calls, 2);
  assert.match(prompts[1], /Refreshed Accessibility context/);
  assert.equal(result.results[0].action, "silent");
});

test("silent: no WeChat send, no keke_state push, queue still drained", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);

  let sendCalled = false;
  let pushCalled = false;
  app.runtimeAdapter.sendSingleTurn = async () => ({ structuredResult: { action: "silent", message: null, reason: "nothing new" } });
  app.channelAdapter.sendText = async () => { sendCalled = true; };
  app.petStateClient.pushExpression = async () => { pushCalled = true; };

  const result = await app.runProactiveDrainTick();

  assert.equal(result.results[0].action, "silent");
  assert.equal(sendCalled, false);
  assert.equal(pushCalled, false);
  assert.equal(app.systemMessageQueueStore.load().messages.length, 0);
});

test("runtimeAdapter throwing degrades to silent, queue still drained (never stuck retrying the same message forever)", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);
  app.runtimeAdapter.sendSingleTurn = async () => { throw new Error("claude exited with code 1"); };

  const result = await app.runProactiveDrainTick();

  assert.equal(result.results[0].action, "silent");
  assert.equal(app.systemMessageQueueStore.load().messages.length, 0);
});

test("runPulseTick calls both runDueIntentionsCheck and runProactiveDrainTick under the same reentrancy guard", async () => {
  const app = buildApp({ pulseIntervalMs: 30, allowedSenderId: "user1" });
  const calls = [];
  app.runDueIntentionsCheck = async () => { calls.push("intentions"); };
  app.runProactiveDrainTick = async () => { calls.push("drain"); };

  await app.runPulseTick();

  assert.deepEqual(calls, ["intentions", "drain"]);
});

test("runProactiveDrainTick failing does not block runDueIntentionsCheck from having run in the same tick", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  let intentionsCalled = false;
  app.runDueIntentionsCheck = async () => { intentionsCalled = true; };
  app.runProactiveDrainTick = async () => { throw new Error("boom"); };

  await app.runPulseTick();

  assert.equal(intentionsCalled, true);
  assert.equal(app.pulseTickInFlight, false, "重入保护应该在两个子任务都结束后复位");
});
