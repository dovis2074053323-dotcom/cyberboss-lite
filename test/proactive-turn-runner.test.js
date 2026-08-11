const test = require("node:test");
const assert = require("node:assert/strict");

const { processProactiveMessage } = require("../src/core/proactive-turn-runner");

function baseMessage(overrides = {}) {
  return {
    id: "msg1",
    source: "event_opportunity",
    createdAt: new Date().toISOString(),
    forced: false,
    bundle: { currentState: {}, openLoops: [], coreMemories: [] },
    ...overrides,
  };
}

function stubs(overrides = {}) {
  return {
    prompt: "prompt",
    callRuntime: async () => ({ structuredResult: { action: "silent", message: null, reason: "nothing going on" } }),
    sendMessage: async () => true,
    markAgentMessageSent: () => {},
    onDeliveryFailed: () => {},
    onLog: () => {},
    ...overrides,
  };
}

test("optional send_message delivers and marks the confirmed outbound message", async () => {
  const sent = [];
  const marked = [];
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: { action: "send_message", message: "在忙吗", reason: "quiet" } }),
    sendMessage: async (text) => { sent.push(text); return true; },
    markAgentMessageSent: (nowIso) => marked.push(nowIso),
  }));
  assert.equal(result.action, "send_message");
  assert.equal(result.sent, true);
  assert.deepEqual(sent, ["在忙吗"]);
  assert.equal(marked.length, 1);
});

test("optional silent has no delivery side effect", async () => {
  let sendCalled = false;
  const result = await processProactiveMessage(baseMessage(), stubs({
    sendMessage: async () => { sendCalled = true; return true; },
  }));
  assert.equal(result.action, "silent");
  assert.equal(sendCalled, false);
});

test("need_context and defer are invalid optional contracts and cannot create a second call", async () => {
  let calls = 0;
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => {
      calls += 1;
      return { structuredResult: { action: "need_context", message: null, reason: "not allowed" } };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(result.action, "silent");
  assert.match(result.reason, /invalid_result/);
});

test("mandatory contract makes one delivery attempt and never accepts silent", async () => {
  const sent = [];
  const result = await processProactiveMessage(baseMessage({ forced: true, source: "mandatory_slot", slotId: "morning" }), stubs({
    callRuntime: async () => ({ structuredResult: { message: "想起你了", reason: "a brief thought" } }),
    sendMessage: async (text) => { sent.push(text); return true; },
  }));
  assert.equal(result.action, "send_message");
  assert.equal(result.sent, true);
  assert.deepEqual(sent, ["想起你了"]);
});

test("mandatory empty message is rejected without another runtime call", async () => {
  let calls = 0;
  const result = await processProactiveMessage(baseMessage({ forced: true, source: "mandatory_slot" }), stubs({
    callRuntime: async () => {
      calls += 1;
      return { structuredResult: { message: "", reason: "bad" } };
    },
  }));
  assert.equal(calls, 1);
  assert.equal(result.action, "mandatory_failed");
  assert.equal(result.sent, false);
});

test("mandatory delivery failure hands the generated text to a pure retry hook", async () => {
  let retryText = null;
  const result = await processProactiveMessage(baseMessage({ forced: true, source: "mandatory_slot" }), stubs({
    callRuntime: async () => ({ structuredResult: { message: "我来啦", reason: "check in" } }),
    sendMessage: async () => false,
    onDeliveryFailed: (text) => { retryText = text; },
  }));
  assert.equal(result.sent, false);
  assert.equal(retryText, "我来啦");
});

test("runtime error is one failed call, not a retry loop", async () => {
  let calls = 0;
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => { calls += 1; throw new Error("claude exited"); },
  }));
  assert.equal(calls, 1);
  assert.equal(result.action, "silent");
  assert.match(result.reason, /runtime_error/);
});
