const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateStructuredResult, normalizeForQuoteMatch, RESULT_JSON_SCHEMA } = require("../src/core/result-schema");

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

function reminderCandidate(overrides = {}) {
  return {
    type: "reminder",
    reason: "内部记录",
    sourceQuote: "提醒我喝水",
    deliveryText: "该喝水啦",
    dueAt: "2026-08-06T21:00:00+08:00",
    ...overrides,
  };
}

test("accepts a minimal well-formed result", () => {
  const result = evaluateStructuredResult(validResult(), { turnUserText: "hi" });
  assert.equal(result.fatal, false);
  assert.equal(result.reply, "好的");
});

// --- Stage 1: fatal shape gate (can't trust `reply` itself) ---

test("fatal: candidate is not an object", () => {
  const result = evaluateStructuredResult("nope", { turnUserText: "hi" });
  assert.equal(result.fatal, true);
});

test("fatal: unknown top-level field (additionalProperties:false)", () => {
  const candidate = validResult({ extra_field: "leak" });
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, true);
  assert.ok(result.fatalErrors.some((error) => error.includes("extra_field")));
});

test("fatal: missing required top-level field", () => {
  const candidate = validResult();
  delete candidate.loops;
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, true);
  assert.ok(result.fatalErrors.some((error) => error.includes('missing required field "loops"')));
});

test("fatal: wrong type for reply", () => {
  const candidate = validResult({ reply: 12345 });
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, true);
});

test("fatal: reply over the 2000 character cap", () => {
  const candidate = validResult({ reply: "a".repeat(2001) });
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, true);
});

test("fatal: statePatch field outside the current-state whitelist", () => {
  const candidate = validResult({ statePatch: { notAllowed: "x" } });
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, true);
  assert.ok(result.fatalErrors.some((error) => error.includes("notAllowed")));
});

test("fatal: memory container isn't shaped like {remember, forget}", () => {
  const candidate = validResult({ memory: { remember: [] } });
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, true);
});

test("fatal: handoff missing required fields", () => {
  const candidate = validResult({ handoff: { summary: "s" } });
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, true);
});

test("accepts a well-formed handoff", () => {
  const candidate = validResult({
    handoff: { summary: "概要", tone: "轻松", openLoops: ["a"], carryForward: ["b"] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.fatal, false);
});

test("the CLI-facing JSON schema forbids additional top-level properties", () => {
  assert.equal(RESULT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    new Set(RESULT_JSON_SCHEMA.required),
    new Set(["reply", "statePatch", "memory", "loops", "intentions", "handoff"]),
  );
});

// --- Stage 2: per-item content evaluation (never fatal — reply must still ship) ---

test("a bad memory item is dropped, not fatal — reply is untouched", () => {
  const candidate = validResult({
    reply: "记住啦",
    memory: {
      remember: [{ category: "preference", fact: "喜欢猫", tier: "core", sourceQuote: "我喜欢猫" }],
      forget: [],
    },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "今天天气不错" });
  assert.equal(result.fatal, false);
  assert.equal(result.reply, "记住啦");
  assert.equal(result.memory.remember.length, 0);
  assert.equal(result.memory.dropped.length, 1);
  assert.ok(result.memory.dropped[0].errors[0].includes("not grounded"));
});

test("a memory fact over the 80 Han-character cap is dropped, not fatal", () => {
  const fact = "喜".repeat(81);
  const candidate = validResult({
    memory: { remember: [{ category: "preference", fact, tier: "core", sourceQuote: "测试" }], forget: [] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "测试" });
  assert.equal(result.fatal, false);
  assert.equal(result.memory.remember.length, 0);
  assert.equal(result.memory.dropped.length, 1);
});

test("more than one memory.remember item: first valid one kept, the rest dropped as over cap", () => {
  const candidate = validResult({
    memory: {
      remember: [
        { category: "preference", fact: "喜欢猫", tier: "core", sourceQuote: "我喜欢猫" },
        { category: "preference", fact: "喜欢狗", tier: "core", sourceQuote: "我也喜欢狗" },
      ],
      forget: [],
    },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "我喜欢猫，我也喜欢狗" });
  assert.equal(result.fatal, false);
  assert.equal(result.memory.remember.length, 1);
  assert.equal(result.memory.remember[0].fact, "喜欢猫");
  assert.equal(result.memory.dropped.length, 1);
  assert.ok(result.memory.dropped[0].errors[0].includes("cap"));
});

test("a bad loop item is dropped, not fatal", () => {
  const candidate = validResult({
    loops: { add: [{ summary: "查航班", sourceQuote: "不存在的引用" }], resolve: [] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "随便聊聊" });
  assert.equal(result.fatal, false);
  assert.equal(result.loops.add.length, 0);
  assert.equal(result.loops.dropped.length, 1);
});

test("an unknown intention type is dropped, not fatal", () => {
  const candidate = validResult({
    intentions: { create: [{ type: "nudge", reason: "a", sourceQuote: "q", deliveryText: "x" }], resolve: [] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "q" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 0);
  assert.equal(result.intentions.droppedCreate.length, 1);
});

test("more than one intentions.create item: first kept, second dropped as over the per-turn cap", () => {
  const candidate = validResult({
    intentions: {
      create: [
        reminderCandidate({ sourceQuote: "q1" }),
        { type: "check_in", reason: "b", sourceQuote: "q2", deliveryText: "在忙嘛" },
      ],
      resolve: [],
    },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "q1 q2" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 1);
  assert.equal(result.intentions.droppedCreate.length, 1);
  assert.ok(result.intentions.droppedCreate[0].errors[0].includes("cap"));
});

// Real bug found live (2026-08-08): a reminder for "cc很萌" was sent as
// "用户要求五分钟后发送指定文字" because the send path used `reason` (an
// internal justification) instead of a real delivery field. deliveryText is
// the fix — required and non-empty for the types that actually get sent.
test("a reminder without deliveryText is dropped, not fatal, and not silently sent via reason", () => {
  const candidate = validResult({
    intentions: {
      create: [{ type: "reminder", reason: "用户要求五分钟后发送指定文字", sourceQuote: "五分钟之后给我发一句：cc很萌。", dueAt: "2026-08-06T21:00:00+08:00" }],
      resolve: [],
    },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "五分钟之后给我发一句：cc很萌。" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 0);
  assert.equal(result.intentions.droppedCreate.length, 1);
  assert.ok(result.intentions.droppedCreate[0].errors.some((e) => e.includes("deliveryText")));
});

test("resume_topic does not require deliveryText", () => {
  const candidate = validResult({
    intentions: { create: [{ type: "resume_topic", reason: "还没聊完", sourceQuote: "改天再聊" }], resolve: [] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "改天再聊" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 1);
  assert.equal(result.intentions.droppedCreate.length, 0);
});

test("rejects (drops) a reminder whose sourceQuote is not grounded in this turn's user text", () => {
  const candidate = validResult({
    intentions: { create: [reminderCandidate()], resolve: [] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "今天天气不错" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 0);
  assert.ok(result.intentions.droppedCreate[0].errors.some((e) => e.includes("not grounded")));
});

test("accepts a reminder whose sourceQuote is grounded and deliveryText is present", () => {
  const candidate = validResult({
    intentions: { create: [reminderCandidate()], resolve: [] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "半小时后提醒我喝水" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 1);
  assert.equal(result.intentions.droppedCreate.length, 0);
});

// --- normalizeForQuoteMatch: tolerate formatting drift, keep wording strict ---

test("normalizeForQuoteMatch folds full-width punctuation and strips whitespace", () => {
  assert.equal(normalizeForQuoteMatch("五分钟之后给我发一句：cc很萌。"), normalizeForQuoteMatch("五分钟之后给我发一句:cc很萌"));
  assert.equal(normalizeForQuoteMatch("提醒我 喝水！"), normalizeForQuoteMatch("提醒我喝水"));
});

test("normalizeForQuoteMatch does not treat different wording as a match", () => {
  assert.notEqual(normalizeForQuoteMatch("提醒我喝水"), normalizeForQuoteMatch("提醒我吃药"));
});

test("a sourceQuote that only differs from the user text by punctuation/whitespace is still grounded", () => {
  const candidate = validResult({
    intentions: {
      create: [reminderCandidate({ sourceQuote: "五分钟之后给我发一句：cc很萌。", deliveryText: "cc很萌" })],
      resolve: [],
    },
  });
  // The user text uses a half-width colon and no trailing period — exactly the
  // kind of drift a model reproducing a quote by hand introduces.
  const result = evaluateStructuredResult(candidate, { turnUserText: "五分钟之后给我发一句:cc很萌" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 1);
});

test("an empty or punctuation-only sourceQuote is never considered grounded", () => {
  const candidate = validResult({
    intentions: { create: [reminderCandidate({ sourceQuote: "。！" })], resolve: [] },
  });
  const result = evaluateStructuredResult(candidate, { turnUserText: "。！随便说点什么" });
  assert.equal(result.fatal, false);
  assert.equal(result.intentions.create.length, 0);
});
