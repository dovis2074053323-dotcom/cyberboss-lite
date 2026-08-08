const test = require("node:test");
const assert = require("node:assert/strict");

const { processProactiveMessage, truncateForBubble } = require("../src/core/proactive-turn-runner");

function baseMessage(overrides = {}) {
  return {
    id: "msg1",
    source: "stochastic_pulse",
    createdAt: new Date().toISOString(),
    bundle: { currentState: {}, openLoops: [], coreMemories: [] },
    ...overrides,
  };
}

function stubs(overrides = {}) {
  return {
    callRuntime: async () => ({ structuredResult: { action: "silent", message: null, reason: "nothing going on" } }),
    fetchRefreshedContext: async () => [],
    sendMessage: async () => true,
    pushExpression: async () => {},
    markAgentMessageSent: () => {},
    onLog: () => {},
    ...overrides,
  };
}

test("truncateForBubble leaves short text untouched, truncates long text with an ellipsis", () => {
  assert.equal(truncateForBubble("短消息"), "短消息");
  const long = "a".repeat(60);
  const truncated = truncateForBubble(long);
  assert.equal(truncated.length, 41); // 40 chars + ellipsis
  assert.ok(truncated.endsWith("…"));
});

test("send_message: sends via sendMessage, marks lastAgentMessageAt, pushes keke_state expression", async () => {
  const sentTexts = [];
  const pushed = [];
  const marked = [];
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: { action: "send_message", message: "在忙吗，想你了", reason: "quiet a while" } }),
    sendMessage: async (text) => { sentTexts.push(text); return true; },
    pushExpression: async (payload) => { pushed.push(payload); },
    markAgentMessageSent: (nowIso) => marked.push(nowIso),
  }));

  assert.equal(result.action, "send_message");
  assert.equal(result.sent, true);
  assert.deepEqual(sentTexts, ["在忙吗，想你了"]);
  assert.equal(marked.length, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].expression, "alert");
  assert.equal(pushed[0].bubbleText, "在忙吗，想你了");
});

test("send_message: sendMessage returning false skips lastAgentMessageAt and keke_state push", async () => {
  const pushed = [];
  const marked = [];
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: { action: "send_message", message: "hi", reason: "r" } }),
    sendMessage: async () => false,
    pushExpression: async (payload) => { pushed.push(payload); },
    markAgentMessageSent: (nowIso) => marked.push(nowIso),
  }));

  assert.equal(result.sent, false);
  assert.equal(marked.length, 0);
  assert.equal(pushed.length, 0);
});

test("send_message: sendMessage throwing is treated as not-sent, not a crash", async () => {
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: { action: "send_message", message: "hi", reason: "r" } }),
    sendMessage: async () => { throw new Error("weixin down"); },
  }));
  assert.equal(result.sent, false);
});

test("silent: no sendMessage/pushExpression/markAgentMessageSent calls", async () => {
  let sendCalled = false;
  let pushCalled = false;
  let markCalled = false;
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: { action: "silent", message: null, reason: "quiet" } }),
    sendMessage: async () => { sendCalled = true; return true; },
    pushExpression: async () => { pushCalled = true; },
    markAgentMessageSent: () => { markCalled = true; },
  }));
  assert.equal(result.action, "silent");
  assert.equal(sendCalled, false);
  assert.equal(pushCalled, false);
  assert.equal(markCalled, false);
});

test("defer: no side effects, distinct action from silent", async () => {
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: { action: "defer", message: null, reason: "not enough signal" } }),
  }));
  assert.equal(result.action, "defer");
});

test("need_context: fetches refreshed Accessibility context and runs a real round 2, applying its decision", async () => {
  const prompts = [];
  const fetchCalls = [];
  const sent = [];
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return { structuredResult: { action: "need_context", message: null, reason: "not enough signal yet" } };
      }
      return { structuredResult: { action: "send_message", message: "在忙嘛", reason: "now I know" } };
    },
    fetchRefreshedContext: async () => {
      fetchCalls.push(true);
      return [{ created_at: "2026-08-09T12:00:00Z", detail: { package: "com.tencent.mm" } }];
    },
    sendMessage: async (text) => { sent.push(text); return true; },
  }));

  assert.equal(fetchCalls.length, 1);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /Refreshed Accessibility context/);
  assert.match(prompts[1], /Refreshed Accessibility context/);
  assert.match(prompts[1], /com\.tencent\.mm/);
  assert.equal(result.action, "send_message");
  assert.deepEqual(sent, ["在忙嘛"]);
});

test("need_context: fetchRefreshedContext throwing still proceeds to round 2 with an error marker, doesn't crash", async () => {
  const prompts = [];
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? { structuredResult: { action: "need_context", message: null, reason: "r" } }
        : { structuredResult: { action: "silent", message: null, reason: "still nothing after refresh" } };
    },
    fetchRefreshedContext: async () => { throw new Error("companion supabase down"); },
  }));

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Refreshed Accessibility context: \(unavailable — companion supabase down\)/);
  assert.equal(result.action, "silent");
});

test("need_context repeated on round 2 is capped, not a third round — falls back to silent", async () => {
  let callCount = 0;
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => {
      callCount += 1;
      return { structuredResult: { action: "need_context", message: null, reason: "still not enough" } };
    },
  }));

  assert.equal(callCount, 2, "应该恰好两轮，不应该有第三轮");
  assert.equal(result.action, "silent");
  assert.match(result.reason, /two-round cap/);
});

test("runtime throwing falls back to silent, never crashes the drain", async () => {
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => { throw new Error("claude exited with code 1"); },
  }));
  assert.equal(result.action, "silent");
  assert.match(result.reason, /runtime_error/);
});

test("malformed structured result falls back to silent, never forwards a possibly-bad message", async () => {
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: { action: "send_message", message: null } }), // send_message requires non-empty message
  }));
  assert.equal(result.action, "silent");
  assert.match(result.reason, /invalid_result/);
});

test("null structuredResult (CLI gave nothing usable) falls back to silent", async () => {
  const result = await processProactiveMessage(baseMessage(), stubs({
    callRuntime: async () => ({ structuredResult: null }),
  }));
  assert.equal(result.action, "silent");
});
