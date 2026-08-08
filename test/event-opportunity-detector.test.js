const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSnapshot, evaluateOpportunity } = require("../src/core/event-opportunity-detector");

const NOW = new Date("2026-08-09T12:00:00Z").getTime();
const LONG_SILENCE_MS = 6 * 60 * 60_000;
const COOLDOWN_MS = 5 * 60_000;

function bundle(overrides = {}) {
  return {
    currentState: { lastUserMessageAt: "2026-08-09T11:00:00Z" },
    openLoops: ["loop A"],
    companionSegments: [{ start_ts: "2026-08-09T11:50:00Z" }],
    taskerSnapshot: { activity: { current_app: "com.example.chrome" }, health: { location_status: "home" } },
    ...overrides,
  };
}

test("buildSnapshot: longSilenceActive true only once elapsed crosses the threshold", () => {
  const recent = buildSnapshot(bundle(), { now: NOW, longSilenceMs: LONG_SILENCE_MS });
  assert.equal(recent.longSilenceActive, false);

  const staleBundle = bundle({ currentState: { lastUserMessageAt: "2026-08-09T05:00:00Z" } }); // 7h ago
  const stale = buildSnapshot(staleBundle, { now: NOW, longSilenceMs: LONG_SILENCE_MS });
  assert.equal(stale.longSilenceActive, true);
});

test("evaluateOpportunity: first-ever observation (no previous) never fires, only establishes baseline", () => {
  const result = evaluateOpportunity({
    bundle: bundle(),
    previous: { snapshot: null, lastFiredAt: null },
    now: NOW,
    cooldownMs: COOLDOWN_MS,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.equal(result.worth, false);
  assert.deepEqual(result.reasons, []);
  assert.ok(result.nextSnapshot);
});

test("evaluateOpportunity: new companion segment fires new_context", () => {
  const previousSnapshot = buildSnapshot(bundle(), { now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const laterBundle = bundle({ companionSegments: [{ start_ts: "2026-08-09T11:58:00Z" }] });
  const result = evaluateOpportunity({
    bundle: laterBundle,
    previous: { snapshot: previousSnapshot, lastFiredAt: null },
    now: NOW,
    cooldownMs: COOLDOWN_MS,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.equal(result.worth, true);
  assert.deepEqual(result.reasons, ["new_context"]);
});

test("evaluateOpportunity: open loop change fires open_loop_change", () => {
  const previousSnapshot = buildSnapshot(bundle(), { now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const laterBundle = bundle({ openLoops: ["loop A", "loop B"] });
  const result = evaluateOpportunity({
    bundle: laterBundle,
    previous: { snapshot: previousSnapshot, lastFiredAt: null },
    now: NOW,
    cooldownMs: COOLDOWN_MS,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(result.reasons, ["open_loop_change"]);
});

test("evaluateOpportunity: current_app change fires environment_change", () => {
  const previousSnapshot = buildSnapshot(bundle(), { now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const laterBundle = bundle({ taskerSnapshot: { activity: { current_app: "com.example.other" }, health: { location_status: "home" } } });
  const result = evaluateOpportunity({
    bundle: laterBundle,
    previous: { snapshot: previousSnapshot, lastFiredAt: null },
    now: NOW,
    cooldownMs: COOLDOWN_MS,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(result.reasons, ["environment_change"]);
});

test("evaluateOpportunity: long silence fires once on the false->true edge, not every tick while it stays true", () => {
  const quietBundle = bundle({ currentState: { lastUserMessageAt: "2026-08-09T05:00:00Z" } });
  const previousSnapshot = buildSnapshot(bundle(), { now: NOW - 10 * 60_000, longSilenceMs: LONG_SILENCE_MS }); // not yet silent
  const first = evaluateOpportunity({
    bundle: quietBundle,
    previous: { snapshot: previousSnapshot, lastFiredAt: null },
    now: NOW,
    cooldownMs: COOLDOWN_MS,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(first.reasons, ["long_silence"]);

  // Next tick, still silent, nothing else changed — must not re-fire.
  const second = evaluateOpportunity({
    bundle: quietBundle,
    previous: { snapshot: first.nextSnapshot, lastFiredAt: new Date(NOW).toISOString() },
    now: NOW + 5 * 60_000,
    cooldownMs: COOLDOWN_MS,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(second.reasons, []);
  assert.equal(second.worth, false);
});

test("evaluateOpportunity: cooldown suppresses worth even when a real delta fired", () => {
  const previousSnapshot = buildSnapshot(bundle(), { now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const laterBundle = bundle({ companionSegments: [{ start_ts: "2026-08-09T11:58:00Z" }] });
  const result = evaluateOpportunity({
    bundle: laterBundle,
    previous: { snapshot: previousSnapshot, lastFiredAt: new Date(NOW - 60_000).toISOString() }, // fired 1min ago
    now: NOW,
    cooldownMs: COOLDOWN_MS, // 5min cooldown, only 1min elapsed
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(result.reasons, ["new_context"]); // delta is still real...
  assert.equal(result.cooldownActive, true);
  assert.equal(result.worth, false); // ...but cooldown blocks firing
});

test("evaluateOpportunity: no changes at all yields no reasons", () => {
  const previousSnapshot = buildSnapshot(bundle(), { now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const result = evaluateOpportunity({
    bundle: bundle(),
    previous: { snapshot: previousSnapshot, lastFiredAt: null },
    now: NOW,
    cooldownMs: COOLDOWN_MS,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(result.reasons, []);
  assert.equal(result.worth, false);
});
