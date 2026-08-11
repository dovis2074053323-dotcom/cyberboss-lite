const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSnapshot, evaluateEvidence } = require("../src/core/event-opportunity-detector");

const NOW = new Date("2026-08-09T12:00:00Z").getTime();
const LONG_SILENCE_MS = 6 * 60 * 60_000;
const EVIDENCE_TTL_MS = 30 * 60_000;

function bundle(overrides = {}) {
  return {
    currentState: { lastUserMessageAt: "2026-08-09T11:00:00Z" },
    openLoops: ["loop A"],
    companionSegments: [{ start_ts: "2026-08-09T11:50:00Z" }],
    taskerSnapshot: { activity: { current_app: "com.example.chrome" }, health: { location_status: "home" } },
    ...overrides,
  };
}

function stateFrom(result, extra = {}) {
  return {
    snapshot: result.nextSnapshot,
    evidence: result.evidence,
    pendingEnvironment: result.nextPendingEnvironment,
    candidate: result.candidate,
    lastFiredAt: null,
    ...extra,
  };
}

test("first snapshot establishes baseline and does not create evidence", () => {
  const result = evaluateEvidence({ bundle: bundle(), previous: {}, now: NOW, longSilenceMs: LONG_SILENCE_MS });
  assert.deepEqual(result.reasons, []);
  assert.equal(result.evidenceScore, 0);
  assert.equal(result.candidate, null);
});

test("a current_app change needs two consecutive polls before environment evidence", () => {
  const first = evaluateEvidence({ bundle: bundle(), previous: {}, now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const changed = evaluateEvidence({
    bundle: bundle({ taskerSnapshot: { activity: { current_app: "com.example.other" }, health: { location_status: "home" } } }),
    previous: stateFrom(first),
    now: NOW + 5 * 60_000,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(changed.reasons, []);
  assert.deepEqual(changed.nextPendingEnvironment, { key: "com.example.other", count: 1 });

  const stable = evaluateEvidence({
    bundle: bundle({ taskerSnapshot: { activity: { current_app: "com.example.other" }, health: { location_status: "home" } } }),
    previous: stateFrom(changed),
    now: NOW + 10 * 60_000,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(stable.reasons, ["environment_change"]);
  assert.equal(stable.evidenceScore, 1);
});

test("location change is immediate but alone stays below candidate threshold", () => {
  const first = evaluateEvidence({ bundle: bundle(), previous: {}, now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const changed = evaluateEvidence({
    bundle: bundle({ taskerSnapshot: { activity: { current_app: "com.example.chrome" }, health: { location_status: "office" } } }),
    previous: stateFrom(first),
    now: NOW + 5 * 60_000,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(changed.reasons, ["environment_change"]);
  assert.equal(changed.candidate, null);
});

test("new_context plus environment reaches the candidate threshold", () => {
  const first = evaluateEvidence({ bundle: bundle(), previous: {}, now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const result = evaluateEvidence({
    bundle: bundle({
      companionSegments: [{ start_ts: "2026-08-09T11:58:00Z" }],
      taskerSnapshot: { activity: { current_app: "com.example.chrome" }, health: { location_status: "office" } },
    }),
    previous: stateFrom(first),
    now: NOW + 5 * 60_000,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(result.reasons, ["new_context", "environment_change"]);
  assert.equal(result.evidenceScore, 3);
  assert.deepEqual(result.candidate.reasons.sort(), ["environment_change", "new_context"]);
});

test("open_loop_change alone reaches the threshold", () => {
  const first = evaluateEvidence({ bundle: bundle(), previous: {}, now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const result = evaluateEvidence({
    bundle: bundle({ openLoops: ["loop A", "loop B"] }),
    previous: stateFrom(first),
    now: NOW + 5 * 60_000,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(result.reasons, ["open_loop_change"]);
  assert.equal(result.evidenceScore, 3);
  assert.ok(result.candidate);
});

test("evidence expires after 30 minutes", () => {
  const first = evaluateEvidence({ bundle: bundle(), previous: {}, now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const changed = evaluateEvidence({
    bundle: bundle({ openLoops: ["loop A", "loop B"] }),
    previous: stateFrom(first),
    now: NOW,
    longSilenceMs: LONG_SILENCE_MS,
  });
  const later = evaluateEvidence({
    bundle: bundle({ openLoops: ["loop A", "loop B"] }),
    previous: stateFrom(changed),
    now: NOW + EVIDENCE_TTL_MS + 1,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.equal(later.evidenceScore, 0);
  assert.equal(later.candidate, null);
});

test("same snapshot does not add duplicate evidence", () => {
  const first = evaluateEvidence({ bundle: bundle(), previous: {}, now: NOW, longSilenceMs: LONG_SILENCE_MS });
  const changed = evaluateEvidence({
    bundle: bundle({ openLoops: ["loop A", "loop B"] }),
    previous: stateFrom(first),
    now: NOW,
    longSilenceMs: LONG_SILENCE_MS,
  });
  const same = evaluateEvidence({
    bundle: bundle({ openLoops: ["loop A", "loop B"] }),
    previous: stateFrom(changed),
    now: NOW + 5 * 60_000,
    longSilenceMs: LONG_SILENCE_MS,
  });
  assert.deepEqual(same.reasons, []);
  assert.equal(same.evidence.length, 1);
});
