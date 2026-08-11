const test = require("node:test");
const assert = require("node:assert/strict");

const { buildProactiveTurnPrompt } = require("../src/core/proactive-turn-builder");

test("optional prompt has only send_message/silent and includes fresh context", () => {
  const prompt = buildProactiveTurnPrompt({}, {
    freshContext: { created_at: "2026-08-11T12:00:00Z", detail: { package: "com.android.chrome" } },
    candidate: { reasons: ["new_context"], evidenceScore: 2 },
  });
  assert.match(prompt, /SYSTEM ACTION MODE: internal proactive check/);
  assert.match(prompt, /Fresh Clawd Accessibility context/);
  assert.match(prompt, /"action":"send_message"/);
  assert.match(prompt, /"action":"silent"/);
  assert.doesNotMatch(prompt, /need_context|defer/);
});

test("optional unavailable context is an input marker, not a second-round request", () => {
  const prompt = buildProactiveTurnPrompt({}, { freshContext: { error: "Morrow context relay timed out" } });
  assert.match(prompt, /Fresh Clawd Accessibility context: \(unavailable — Morrow context relay timed out\)/);
  assert.doesNotMatch(prompt, /need_context|round 2/);
});

test("filtered Accessibility context is distinct from unavailable", () => {
  const prompt = buildProactiveTurnPrompt({}, {
    freshContext: { created_at: "2026-08-11T12:00:00Z", detail: { filtered: true, filterReason: "sensitive_app" } },
  });
  assert.match(prompt, /device looked, but withheld it — sensitive_app/);
});

test("mandatory prompt requires one natural message and forbids internal explanations", () => {
  const prompt = buildProactiveTurnPrompt({}, {
    forced: true,
    freshContext: { error: "unavailable" },
  });
  assert.match(prompt, /mandatory outreach slot/);
  assert.match(prompt, /You must return exactly one JSON object/);
  assert.match(prompt, /Do not mention monitoring, observations, slots, schedules, or internal systems/);
  assert.match(prompt, /"message":"<short natural message>"/);
  assert.doesNotMatch(prompt, /"action"/);
  assert.match(prompt, /Do not return silent/);
});

test("renders lists and compact companion segments", () => {
  const prompt = buildProactiveTurnPrompt({
    openLoops: ["答应帮她订生日蛋糕"],
    coreMemories: ["喜欢薄荷绿"],
    companionSegments: [{ start_ts: "a", end_ts: "b", screen_active: true, contexts: [{ package: "com.tencent.mm" }], interaction: { tap: 2 } }],
  }, { freshContext: null });
  assert.match(prompt, /Open loops:\n- 答应帮她订生日蛋糕/);
  assert.match(prompt, /Core memory:\n- 喜欢薄荷绿/);
  assert.match(prompt, /a~b screen_active=true contexts=\[{"package":"com\.tencent\.mm"}\]/);
});
