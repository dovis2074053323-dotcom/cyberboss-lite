const test = require("node:test");
const assert = require("node:assert/strict");

const { buildProactiveTurnPrompt } = require("../src/core/proactive-turn-builder");

test("includes the narrow-contract JSON examples and system-action framing", () => {
  const prompt = buildProactiveTurnPrompt({});
  assert.match(prompt, /SYSTEM ACTION MODE: internal proactive check/);
  assert.match(prompt, /"action":"send_message"/);
  assert.match(prompt, /"action":"silent"/);
  assert.match(prompt, /"action":"need_vision"/);
  assert.match(prompt, /"action":"defer"/);
});

test("renders open loops and core memory as bullet lists when present", () => {
  const prompt = buildProactiveTurnPrompt({
    openLoops: ["答应帮她订生日蛋糕"],
    coreMemories: ["喜欢薄荷绿"],
  });
  assert.match(prompt, /Open loops:\n- 答应帮她订生日蛋糕/);
  assert.match(prompt, /Core memory:\n- 喜欢薄荷绿/);
});

test("renders (none) for empty/missing lists and (unavailable) for error markers", () => {
  const prompt = buildProactiveTurnPrompt({
    openLoops: [],
    taskerSnapshot: { error: "tasker down" },
    companionSegments: { error: "companion down" },
  });
  assert.match(prompt, /Open loops: \(none\)/);
  assert.match(prompt, /Tasker snapshot.*\(unavailable — tasker down\)/);
  assert.match(prompt, /Recent companion segments: \(unavailable — companion down\)/);
});

test("renders companion segments compactly with contexts/interaction inline", () => {
  const prompt = buildProactiveTurnPrompt({
    companionSegments: [
      { start_ts: "a", end_ts: "b", screen_active: true, contexts: [{ package: "com.tencent.mm" }], interaction: { tap: 2 } },
    ],
  });
  assert.match(prompt, /a~b screen_active=true contexts=\[{"package":"com\.tencent\.mm"}\] interaction={"tap":2}/);
});
