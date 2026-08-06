const test = require("node:test");
const assert = require("node:assert/strict");

const { validateStructuredResult, RESULT_JSON_SCHEMA } = require("../src/core/result-schema");

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

test("accepts a minimal well-formed result", () => {
  const result = validateStructuredResult(validResult(), { turnUserText: "hi" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("rejects an unknown top-level field (additionalProperties:false)", () => {
  const candidate = validResult({ extra_field: "leak" });
  const result = validateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("extra_field")));
});

test("rejects a missing required top-level field", () => {
  const candidate = validResult();
  delete candidate.loops;
  const result = validateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('missing required field "loops"')));
});

test("rejects wrong type for reply", () => {
  const candidate = validResult({ reply: 12345 });
  const result = validateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith("reply:")));
});

test("rejects reply over the 2000 character cap", () => {
  const candidate = validResult({ reply: "a".repeat(2001) });
  const result = validateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.valid, false);
});

test("rejects statePatch fields outside the current-state whitelist", () => {
  const candidate = validResult({ statePatch: { notAllowed: "x" } });
  const result = validateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("notAllowed")));
});

test("rejects more than one memory.remember item per turn", () => {
  const candidate = validResult({
    memory: {
      remember: [
        { category: "preference", fact: "喜欢猫", tier: "core", sourceQuote: "我喜欢猫" },
        { category: "preference", fact: "喜欢狗", tier: "core", sourceQuote: "我也喜欢狗" },
      ],
      forget: [],
    },
  });
  const result = validateStructuredResult(candidate, { turnUserText: "我喜欢猫，我也喜欢狗" });
  assert.equal(result.valid, false);
});

test("rejects a memory sourceQuote that is not verbatim in this turn's user text", () => {
  const candidate = validResult({
    memory: {
      remember: [{ category: "preference", fact: "喜欢猫", tier: "core", sourceQuote: "我喜欢猫" }],
      forget: [],
    },
  });
  const result = validateStructuredResult(candidate, { turnUserText: "今天天气不错" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("verbatim")));
});

test("rejects a memory fact over the 80 Han-character cap", () => {
  const fact = "喜".repeat(81);
  const candidate = validResult({
    memory: {
      remember: [{ category: "preference", fact, tier: "core", sourceQuote: "测试" }],
      forget: [],
    },
  });
  const result = validateStructuredResult(candidate, { turnUserText: "测试" });
  assert.equal(result.valid, false);
});

test("rejects more than one intentions.create item per turn", () => {
  const candidate = validResult({
    intentions: {
      create: [
        { type: "reminder", reason: "a", sourceQuote: "q", dueAt: "2026-08-06T21:00:00+08:00" },
        { type: "check_in", reason: "b", sourceQuote: "q" },
      ],
      resolve: [],
    },
  });
  const result = validateStructuredResult(candidate, { turnUserText: "q" });
  assert.equal(result.valid, false);
});

test("rejects an unknown intention type", () => {
  const candidate = validResult({
    intentions: { create: [{ type: "nudge", reason: "a", sourceQuote: "q" }], resolve: [] },
  });
  const result = validateStructuredResult(candidate, { turnUserText: "q" });
  assert.equal(result.valid, false);
});

test("rejects a handoff missing required fields", () => {
  const candidate = validResult({ handoff: { summary: "s" } });
  const result = validateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.valid, false);
});

test("accepts a well-formed handoff", () => {
  const candidate = validResult({
    handoff: { summary: "概要", tone: "轻松", openLoops: ["a"], carryForward: ["b"] },
  });
  const result = validateStructuredResult(candidate, { turnUserText: "hi" });
  assert.equal(result.valid, true);
});

test("the CLI-facing JSON schema forbids additional top-level properties", () => {
  assert.equal(RESULT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    new Set(RESULT_JSON_SCHEMA.required),
    new Set(["reply", "statePatch", "memory", "loops", "intentions", "handoff"]),
  );
});
