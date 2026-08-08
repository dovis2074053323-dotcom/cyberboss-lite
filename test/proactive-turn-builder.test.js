const test = require("node:test");
const assert = require("node:assert/strict");

const { buildProactiveTurnPrompt } = require("../src/core/proactive-turn-builder");

test("round 1 (no refreshedContext): includes the narrow-contract JSON examples including need_context", () => {
  const prompt = buildProactiveTurnPrompt({});
  assert.match(prompt, /SYSTEM ACTION MODE: internal proactive check/);
  assert.match(prompt, /"action":"send_message"/);
  assert.match(prompt, /"action":"silent"/);
  assert.match(prompt, /"action":"need_context"/);
  assert.match(prompt, /"action":"defer"/);
});

test("round 2 (refreshedContext given): drops need_context from the menu entirely, renders the device's real answer", () => {
  const prompt = buildProactiveTurnPrompt({}, {
    refreshedContext: { created_at: "2026-08-09T12:00:00Z", detail: { package: "com.android.chrome", activity: "MainActivity", title: "some page" } },
  });
  assert.match(prompt, /round 2/);
  assert.match(prompt, /Refreshed Accessibility context \(as of 2026-08-09T12:00:00Z\): {"package":"com\.android\.chrome","activity":"MainActivity","title":"some page"}/);
  assert.match(prompt, /"action":"send_message"/);
  assert.match(prompt, /"action":"silent"/);
  assert.match(prompt, /"action":"defer"/);
  assert.doesNotMatch(prompt, /"action":"need_context"/);
});

test("round 2 with an error marker renders (unavailable) — the request itself never got a response", () => {
  const prompt = buildProactiveTurnPrompt({}, { refreshedContext: { error: "timed out waiting for context_snapshot response" } });
  assert.match(prompt, /Refreshed Accessibility context: \(unavailable — timed out waiting for context_snapshot response\)/);
  assert.doesNotMatch(prompt, /"action":"need_context"/);
});

test("round 2 with detail.filtered renders the device's real (withheld) answer, distinct from (unavailable)", () => {
  const prompt = buildProactiveTurnPrompt({}, {
    refreshedContext: { created_at: "2026-08-09T12:00:00Z", detail: { requestId: "r1", package: "com.tencent.mm", filtered: true, filterReason: "no_text_extraction_package" } },
  });
  assert.match(prompt, /Refreshed Accessibility context: \(device looked, but withheld it — no_text_extraction_package\)/);
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
