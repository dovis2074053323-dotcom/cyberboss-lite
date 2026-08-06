const test = require("node:test");
const assert = require("node:assert/strict");

const { TurnGateStore } = require("../src/core/turn-gate-store");

test("turn gate tracks pending scopes until the turn is released", () => {
  const gate = new TurnGateStore();
  const scopeKey = gate.begin("binding-1", "/workspace");

  assert.equal(scopeKey, "binding-1::/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), true);

  gate.attachThread(scopeKey, "thread-1");
  gate.releaseThread("thread-1");

  assert.equal(gate.isPending("binding-1", "/workspace"), false);
});
