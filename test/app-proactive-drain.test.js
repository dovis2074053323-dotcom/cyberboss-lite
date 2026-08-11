const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApp } = require("./helpers/app-test-config");
const { acquireHostLock } = require("../src/core/host-lock");

function enqueueOne(app, overrides = {}) {
  const state = app.systemMessageQueueStore.load();
  const next = app.systemMessageQueueStore.enqueue(state, {
    id: "msg1",
    source: "event_opportunity",
    createdAt: new Date().toISOString(),
    forced: false,
    reasons: ["open_loop_change"],
    evidenceScore: 3,
    ...overrides,
  });
  app.systemMessageQueueStore.save(next);
}

function useFreshContext(app, value = { created_at: "2026-08-11T12:00:00Z", detail: { package: "com.android.chrome" } }) {
  app.morrowContextRelay.requestContext = async () => value;
}

function makeDueSlot(app, nowMs = Date.now(), slotId = "morning") {
  const state = app.proactiveBudgetStore.load(nowMs);
  const slots = state.slots.map((slot) => slot.id === slotId
    ? {
      ...slot,
      startAt: new Date(nowMs - 60_000).toISOString(),
      targetAt: new Date(nowMs - 1_000).toISOString(),
      endAt: new Date(nowMs + 60 * 60_000).toISOString(),
    }
    : slot);
  app.proactiveBudgetStore.save({ ...state, slots });
}

test("empty queue: never touches runtime or channel", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  let runtimeCalled = false;
  app.runtimeAdapter.sendSingleTurn = async () => { runtimeCalled = true; };
  app.channelAdapter.sendText = async () => { throw new Error("must not send"); };

  const result = await app.runProactiveDrainTick();
  assert.equal(result.reason, "empty");
  assert.equal(runtimeCalled, false);
});

test("no allowedSenderId leaves the candidate queued", async () => {
  const app = buildApp();
  enqueueOne(app);
  const result = await app.runProactiveDrainTick();
  assert.equal(result.reason, "no_allowed_sender");
  assert.equal(app.systemMessageQueueStore.load().messages.length, 1);
});

test("host lock busy leaves the candidate queued and consumes no call", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);
  const holder = await acquireHostLock({ lockDir: app.config.hostLockDir, kind: "test_hold", timeoutMs: 0 });
  try {
    const result = await app.runProactiveDrainTick();
    assert.equal(result.reason, "lock_busy");
    assert.equal(app.systemMessageQueueStore.load().messages.length, 1);
    assert.equal(app.proactiveBudgetStore.load().totalCalls, 0);
  } finally {
    await holder.release();
  }
});

test("a different forced queue item prevents a second mandatory item", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  const now = Date.now();
  makeDueSlot(app, now, "morning");
  const budget = app.proactiveBudgetStore.load(now);
  app.proactiveBudgetStore.save({
    ...budget,
    slots: budget.slots.map((slot) => slot.id === "morning"
      ? slot
      : {
        ...slot,
        startAt: new Date(now + 60 * 60_000).toISOString(),
        targetAt: new Date(now + 60 * 60_000).toISOString(),
        endAt: new Date(now + 2 * 60 * 60_000).toISOString(),
      }),
  });
  const state = app.systemMessageQueueStore.load();
  app.systemMessageQueueStore.save(app.systemMessageQueueStore.enqueue(state, {
    id: "afternoon-forced",
    source: "mandatory_slot",
    createdAt: new Date(now).toISOString(),
    forced: true,
    slotId: "afternoon",
  }));

  const result = await app.runMandatorySlotCheck(now);
  assert.equal(result.reason, "queue_pending");
  assert.equal(app.systemMessageQueueStore.load().messages.length, 1);
});

test("optional send rebuilds the latest bundle, refreshes Clawd once, and calls Claude once", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app, { bundle: { stale: true } });
  app.observationBundleBuilder.build = async () => ({ currentState: { currentActivity: "latest" }, openLoops: [], coreMemories: [], taskerSnapshot: {}, companionSegments: [] });
  useFreshContext(app);
  const prompts = [];
  const sent = [];
  app.runtimeAdapter.sendSingleTurn = async ({ text, resultSchema }) => {
    prompts.push({ text, resultSchema });
    return { structuredResult: { action: "send_message", message: "在呢", reason: "a real candidate" } };
  };
  app.channelAdapter.sendText = async ({ userId, text }) => { sent.push({ userId, text }); };

  const result = await app.runProactiveDrainTick();
  assert.equal(result.results[0].sent, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /latest/);
  assert.match(prompts[0].text, /Fresh Clawd Accessibility context/);
  assert.equal(prompts[0].resultSchema.required.includes("action"), true);
  assert.deepEqual(sent, [{ userId: "user1", text: "在呢" }]);
  assert.equal(app.proactiveBudgetStore.load().totalCalls, 1);
});

test("a local preparation failure keeps the candidate and rolls back the reservation", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);
  useFreshContext(app);
  app.observationBundleBuilder.build = async () => { throw new Error("local observation failure"); };

  await assert.rejects(() => app.runProactiveDrainTick(), /local observation failure/);
  assert.equal(app.systemMessageQueueStore.load().messages.length, 1);
  assert.equal(app.proactiveBudgetStore.load().totalCalls, 0);
});

test("optional silent consumes one call but does not send", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);
  useFreshContext(app);
  let sendCalled = false;
  app.runtimeAdapter.sendSingleTurn = async () => ({ structuredResult: { action: "silent", message: null, reason: "not worth interrupting" } });
  app.channelAdapter.sendText = async () => { sendCalled = true; };
  const result = await app.runProactiveDrainTick();
  assert.equal(result.results[0].action, "silent");
  assert.equal(sendCalled, false);
  assert.equal(app.proactiveBudgetStore.load().silentDecisions, 1);
  assert.equal(app.proactiveBudgetStore.load().totalCalls, 1);
});

test("fresh context timeout still makes exactly one Claude call", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);
  app.morrowContextRelay.requestContext = async () => { throw new Error("Morrow context relay timed out after 15000ms"); };
  let calls = 0;
  let prompt = "";
  app.runtimeAdapter.sendSingleTurn = async ({ text }) => {
    calls += 1;
    prompt = text;
    return { structuredResult: { action: "silent", message: null, reason: "no fresh context" } };
  };
  const result = await app.runProactiveDrainTick();
  assert.equal(calls, 1);
  assert.equal(result.results[0].action, "silent");
  assert.match(prompt, /Fresh Clawd Accessibility context: \(unavailable/);
  assert.equal(app.proactiveBudgetStore.load().contextRefreshTimeout, 1);
});

test("runtime error after invocation counts against the daily budget", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  enqueueOne(app);
  useFreshContext(app);
  app.runtimeAdapter.sendSingleTurn = async () => { throw new Error("runtime failed after start"); };
  const result = await app.runProactiveDrainTick();
  assert.equal(result.results[0].action, "silent");
  assert.equal(app.proactiveBudgetStore.load().totalCalls, 1);
  assert.equal(app.systemMessageQueueStore.load().messages.length, 0);
});

test("mandatory due slot uses its own contract and satisfies only after successful delivery", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  const now = Date.now();
  makeDueSlot(app, now, "morning");
  useFreshContext(app);
  await app.runMandatorySlotCheck(now);
  assert.equal(app.systemMessageQueueStore.load().messages[0].forced, true);
  app.runtimeAdapter.sendSingleTurn = async ({ resultSchema }) => {
    assert.deepEqual(resultSchema.required, ["message", "reason"]);
    return { structuredResult: { message: "想到你了，今天还好吗？", reason: "mandatory outreach" } };
  };
  app.channelAdapter.sendText = async () => {};
  const result = await app.runProactiveDrainTick();
  assert.equal(result.results[0].sent, true);
  assert.equal(app.proactiveBudgetStore.getSlot("morning").satisfied, true);
  assert.equal(app.proactiveBudgetStore.load().mandatoryCalls, 1);
});

test("mandatory delivery failure persists text and retry does not call Claude again", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  const now = Date.now();
  makeDueSlot(app, now, "morning");
  useFreshContext(app);
  await app.runMandatorySlotCheck(now);
  let calls = 0;
  app.runtimeAdapter.sendSingleTurn = async () => {
    calls += 1;
    return { structuredResult: { message: "我来陪你一下", reason: "mandatory outreach" } };
  };
  let deliveries = 0;
  app.channelAdapter.sendText = async () => {
    deliveries += 1;
    if (deliveries === 1) throw new Error("temporary WeChat failure");
  };
  const first = await app.runProactiveDrainTick();
  assert.equal(first.results[0].sent, false);
  assert.equal(calls, 1);
  assert.equal(app.proactiveBudgetStore.getSlot("morning").satisfied, false);
  assert.equal(app.proactiveBudgetStore.pendingDeliveries()[0].deliveryText, "我来陪你一下");

  await app.retryMandatoryDeliveries();
  assert.equal(deliveries, 2);
  assert.equal(calls, 1);
  assert.equal(app.proactiveBudgetStore.getSlot("morning").satisfied, true);
});

test("an optional send inside a mandatory window satisfies that slot", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  const now = Date.now();
  makeDueSlot(app, now, "morning");
  const state = app.proactiveBudgetStore.load(now);
  app.proactiveBudgetStore.save({
    ...state,
    slots: state.slots.map((slot) => slot.id === "morning"
      ? { ...slot, targetAt: new Date(now + 60_000).toISOString() }
      : slot),
  });
  enqueueOne(app);
  useFreshContext(app);
  app.runtimeAdapter.sendSingleTurn = async () => ({ structuredResult: { action: "send_message", message: "午安", reason: "natural" } });
  app.channelAdapter.sendText = async () => {};
  await app.runProactiveDrainTick();
  assert.equal(app.proactiveBudgetStore.getSlot("morning").satisfied, true);
});

test("runPulseTick keeps intentions, mandatory checks, and drain under one guard", async () => {
  const app = buildApp({ allowedSenderId: "user1" });
  const calls = [];
  app.runDueIntentionsCheck = async () => { calls.push("intentions"); };
  app.retryMandatoryDeliveries = async () => { calls.push("delivery"); };
  app.runMandatorySlotCheck = async () => { calls.push("mandatory"); };
  app.runProactiveDrainTick = async () => { calls.push("drain"); };
  await app.runPulseTick();
  assert.deepEqual(calls, ["intentions", "delivery", "mandatory", "drain"]);
});
