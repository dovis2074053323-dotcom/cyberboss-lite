const test = require("node:test");
const assert = require("node:assert/strict");

const { assembleTurnContext } = require("../src/core/context-assembler");
const { estimateTokens } = require("../src/core/token-estimate");

function baseArgs(overrides = {}) {
  return {
    agentName: "小总裁",
    nowIso: "2026-08-06T20:00:00.000Z",
    coreMemories: [{ category: "identity", fact: "用户是软件工程师" }],
    contextualMemories: [{ category: "preference", fact: "喜欢喝咖啡" }],
    currentState: {
      currentActivity: "写代码",
      expectedReturnAt: null,
      recentMood: "专注",
      lastUserMessageAt: "2026-08-06T19:00:00.000Z",
      lastAgentMessageAt: "2026-08-06T19:00:05.000Z",
    },
    openLoops: [{ id: "loop_1", summary: "帮忙查航班" }],
    carryContext: null,
    episodeMessages: [{ role: "user", text: "早上好" }, { role: "assistant", text: "早呀" }],
    pendingResumeTopics: [],
    mergedText: "在忙嘛",
    receivedAtLocal: "2026-08-06 20:00",
    rolloverRequested: false,
    ...overrides,
  };
}

test("sections appear in the exact spec §7 order", () => {
  const text = assembleTurnContext(baseArgs({
    carryContext: { type: "handoff", handoff: { summary: "概要", tone: "轻松", openLoops: [], carryForward: [] } },
    pendingResumeTopics: [{ reason: "还没聊完的话题", context: "" }],
    rolloverRequested: true,
  }));

  const order = [
    "[MODE:", "== 核心记忆 ==", "== 相关记忆 ==", "== 当前状态 ==", "== 未完成事项 ==",
    "== 上一段对话交接 ==", "== 当前对话 ==", "== 待唤醒的话题 ==", "== 本轮用户消息 ==",
    "[ROLLOVER_REQUESTED: true",
  ];
  let cursor = -1;
  for (const marker of order) {
    const index = text.indexOf(marker);
    assert.ok(index !== -1, `expected to find "${marker}"`);
    assert.ok(index > cursor, `expected "${marker}" to appear after the previous section`);
    cursor = index;
  }
});

test("empty sections render as (无) rather than being silently dropped", () => {
  const text = assembleTurnContext(baseArgs({
    coreMemories: [], contextualMemories: [], openLoops: [], episodeMessages: [],
  }));
  assert.match(text, /== 核心记忆 ==\n（无）/);
  assert.match(text, /== 相关记忆 ==\n（无）/);
  assert.match(text, /== 未完成事项 ==\n（无）/);
  assert.match(text, /== 当前对话 ==\n（无）/);
});

test("rolloverRequested marker is absent when false", () => {
  const text = assembleTurnContext(baseArgs({ rolloverRequested: false }));
  assert.doesNotMatch(text, /ROLLOVER_REQUESTED/);
});

test("carry context omits its section entirely when there is none (no stray heading)", () => {
  const text = assembleTurnContext(baseArgs({ carryContext: null }));
  assert.doesNotMatch(text, /上一段对话/);
});

test("resume topics section is omitted entirely when there are none pending", () => {
  const text = assembleTurnContext(baseArgs({ pendingResumeTopics: [] }));
  assert.doesNotMatch(text, /待唤醒的话题/);
});

test("a typical modest turn stays comfortably under the 4000 estimated-token target", () => {
  const text = assembleTurnContext(baseArgs());
  assert.ok(estimateTokens(text) < 4000, `expected <4000 estimated tokens, got ${estimateTokens(text)}`);
});
