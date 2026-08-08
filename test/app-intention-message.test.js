const test = require("node:test");
const assert = require("node:assert/strict");

const { buildIntentionMessageText } = require("../src/core/app");

// Real bug found live (2026-08-08): a reminder for "cc很萌" was delivered as
// "用户要求五分钟后发送指定文字" because this function used to send `reason`
// (the model's internal justification) instead of a real delivery field.
test("prefers deliveryText over reason when both are present", () => {
  const text = buildIntentionMessageText({
    reason: "用户要求五分钟后发送指定文字",
    deliveryText: "cc很萌",
    context: "",
  });
  assert.equal(text, "cc很萌");
});

test("falls back to reason for intentions persisted before deliveryText existed", () => {
  const text = buildIntentionMessageText({ reason: "该喝水啦", context: "" });
  assert.equal(text, "该喝水啦");
});

test("appends context after the primary text when present", () => {
  const text = buildIntentionMessageText({ deliveryText: "cc很萌", context: "备注" });
  assert.equal(text, "cc很萌\n备注");
});

test("returns empty string when neither deliveryText nor reason is set", () => {
  assert.equal(buildIntentionMessageText({}), "");
  assert.equal(buildIntentionMessageText(null), "");
});
