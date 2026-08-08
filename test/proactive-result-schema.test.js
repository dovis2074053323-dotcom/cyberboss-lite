const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateProactiveResult, ACTIONS, LIMITS } = require("../src/core/proactive-result-schema");

test("accepts a well-formed send_message", () => {
  const result = evaluateProactiveResult({ action: "send_message", message: "在呢", reason: "vv安静了很久" });
  assert.equal(result.fatal, false);
  assert.equal(result.action, "send_message");
  assert.equal(result.message, "在呢");
});

test("accepts silent/need_vision/defer with message: null", () => {
  for (const action of ["silent", "need_vision", "defer"]) {
    const result = evaluateProactiveResult({ action, message: null });
    assert.equal(result.fatal, false, action);
    assert.equal(result.message, null, action);
  }
});

test("reason is optional and defaults to null", () => {
  const result = evaluateProactiveResult({ action: "silent", message: null });
  assert.equal(result.reason, null);
});

test("fatal: not an object", () => {
  assert.equal(evaluateProactiveResult("nope").fatal, true);
  assert.equal(evaluateProactiveResult(null).fatal, true);
  assert.equal(evaluateProactiveResult(["send_message"]).fatal, true);
});

test("fatal: unknown top-level field (no memory/loops/intentions smuggled in)", () => {
  const result = evaluateProactiveResult({ action: "silent", message: null, memory: { remember: [] } });
  assert.equal(result.fatal, true);
  assert.match(result.errors[0], /unknown top-level field "memory"/);
});

test("fatal: invalid action value", () => {
  const result = evaluateProactiveResult({ action: "reply", message: null });
  assert.equal(result.fatal, true);
});

test("fatal: send_message with empty/missing message", () => {
  assert.equal(evaluateProactiveResult({ action: "send_message", message: null }).fatal, true);
  assert.equal(evaluateProactiveResult({ action: "send_message", message: "" }).fatal, true);
  assert.equal(evaluateProactiveResult({ action: "send_message", message: "   " }).fatal, true);
});

test("fatal: non-send_message action carrying a non-empty message", () => {
  const result = evaluateProactiveResult({ action: "silent", message: "偷偷说一句" });
  assert.equal(result.fatal, true);
  assert.match(result.errors[0], /must not include a message/);
});

test("fatal: message exceeds max length", () => {
  const result = evaluateProactiveResult({ action: "send_message", message: "x".repeat(LIMITS.messageMaxChars + 1) });
  assert.equal(result.fatal, true);
});

test("fatal: reason exceeds max length", () => {
  const result = evaluateProactiveResult({ action: "silent", message: null, reason: "x".repeat(LIMITS.reasonMaxChars + 1) });
  assert.equal(result.fatal, true);
});

test("ACTIONS is exactly the four decided actions, no more no less", () => {
  assert.deepEqual([...ACTIONS].sort(), ["defer", "need_vision", "send_message", "silent"]);
});
