const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateProactiveResult,
  evaluateMandatoryResult,
  ACTIONS,
  LIMITS,
} = require("../src/core/proactive-result-schema");

test("optional accepts send_message and silent only", () => {
  assert.equal(evaluateProactiveResult({ action: "send_message", message: "在呢", reason: "natural" }).fatal, false);
  assert.equal(evaluateProactiveResult({ action: "silent", message: null, reason: "nothing new" }).fatal, false);
});

test("optional no longer accepts need_context or defer", () => {
  assert.equal(evaluateProactiveResult({ action: "need_context", message: null, reason: "r" }).fatal, true);
  assert.equal(evaluateProactiveResult({ action: "defer", message: null, reason: "r" }).fatal, true);
});

test("mandatory accepts a message without an action field", () => {
  const result = evaluateMandatoryResult({ message: "想起你了", reason: "brief thought" });
  assert.equal(result.fatal, false);
  assert.equal(result.message, "想起你了");
});

test("mandatory rejects empty message and silent-shaped results", () => {
  assert.equal(evaluateMandatoryResult({ message: "", reason: "r" }).fatal, true);
  assert.equal(evaluateMandatoryResult({ action: "silent", message: null, reason: "r" }).fatal, true);
});

test("unknown durable-state fields are always fatal", () => {
  assert.equal(evaluateProactiveResult({ action: "silent", message: null, reason: "r", memory: {} }).fatal, true);
  assert.equal(evaluateMandatoryResult({ message: "hi", reason: "r", loops: [] }).fatal, true);
});

test("message and reason length limits are enforced", () => {
  assert.equal(evaluateProactiveResult({ action: "send_message", message: "x".repeat(LIMITS.messageMaxChars + 1), reason: "r" }).fatal, true);
  assert.equal(evaluateMandatoryResult({ message: "hi", reason: "x".repeat(LIMITS.reasonMaxChars + 1) }).fatal, true);
});

test("ACTIONS is exactly the two optional decisions", () => {
  assert.deepEqual([...ACTIONS].sort(), ["send_message", "silent"]);
});
