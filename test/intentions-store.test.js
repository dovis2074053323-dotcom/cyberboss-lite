const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createIntentionsStore, executeDueIntentions, PENDING_CAP } = require("../src/core/intentions-store");
const { StateCorruptionError } = require("../src/core/json-store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-intentions-test-"));
  return { intentionsFile: path.join(dir, "intentions.json") };
}

const NOW_ISO = "2026-08-06T10:00:00.000Z";

test("create a reminder with a valid future dueAt", () => {
  const store = createIntentionsStore(tempConfig());
  const { state, outcome, intention } = store.create(store.load(), {
    type: "reminder", reason: "喝水", sourceQuote: "提醒我喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO, sourceTurnId: "turn-1" });

  assert.equal(outcome, "created");
  assert.match(intention.id, /^int_/);
  assert.equal(intention.status, "pending");
  assert.equal(intention.cancelOnInbound, false);
  assert.equal(state.intentions.length, 1);
});

test("rejects a reminder without a parseable dueAt", () => {
  const store = createIntentionsStore(tempConfig());
  const { outcome, reason } = store.create(store.load(), {
    type: "reminder", reason: "喝水", sourceQuote: "提醒我喝水", dueAt: "soon-ish",
  }, { nowIso: NOW_ISO });
  assert.equal(outcome, "rejected_invalid");
  assert.match(reason, /dueAt/);
});

test("rejects a reminder whose dueAt is in the past", () => {
  const store = createIntentionsStore(tempConfig());
  const { outcome } = store.create(store.load(), {
    type: "reminder", reason: "喝水", sourceQuote: "提醒我喝水", dueAt: "2020-01-01T00:00:00.000Z",
  }, { nowIso: NOW_ISO });
  assert.equal(outcome, "rejected_invalid");
});

test("accepts a check_in within the 48h horizon and rejects one beyond it", () => {
  const store = createIntentionsStore(tempConfig());
  const within = store.create(store.load(), {
    type: "check_in", reason: "用户提到明天有面试", sourceQuote: "明天有面试", dueAt: "2026-08-08T00:00:00.000Z",
  }, { nowIso: NOW_ISO });
  assert.equal(within.outcome, "created");
  assert.equal(within.intention.cancelOnInbound, true);

  const beyond = store.create(store.load(), {
    type: "check_in", reason: "用户提到下周", sourceQuote: "下周", dueAt: "2026-08-20T00:00:00.000Z",
  }, { nowIso: NOW_ISO });
  assert.equal(beyond.outcome, "rejected_invalid");
});

test("resume_topic defaults expiresAt to 7 days out when the model doesn't supply one", () => {
  const store = createIntentionsStore(tempConfig());
  const { intention } = store.create(store.load(), {
    type: "resume_topic", reason: "还没聊完的话题", sourceQuote: "改天再聊", context: "职业规划",
  }, { nowIso: NOW_ISO });
  assert.equal(intention.dueAt, null);
  assert.equal(intention.expiresAt, "2026-08-13T10:00:00.000Z");
  assert.equal(intention.cancelOnInbound, true);
});

test("a near-duplicate pending intention merges instead of creating a second one", () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, {
    type: "resume_topic", reason: "还没聊完的话题", sourceQuote: "改天再聊",
  }, { nowIso: NOW_ISO }));

  const second = store.create(state, {
    type: "resume_topic", reason: "  还没聊完的话题  ", sourceQuote: "改天接着聊",
  }, { nowIso: NOW_ISO });
  assert.equal(second.outcome, "merged");
  assert.equal(second.state.intentions.length, 1);
});

test("pending intentions are capped at 10 total", () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  for (let i = 0; i < PENDING_CAP; i += 1) {
    ({ state } = store.create(state, {
      type: "resume_topic", reason: `话题${i}`, sourceQuote: `话题${i}`,
    }, { nowIso: NOW_ISO }));
  }
  assert.equal(store.pending(state).length, PENDING_CAP);

  const overflow = store.create(state, {
    type: "resume_topic", reason: "第11个话题", sourceQuote: "第11个话题",
  }, { nowIso: NOW_ISO });
  assert.equal(overflow.outcome, "rejected_pending_cap");
});

test("resolve marks matching pending ids resolved and ignores unknown ids", () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  let intention;
  ({ state, intention } = store.create(state, {
    type: "reminder", reason: "喝水", sourceQuote: "喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO }));

  const { state: resolvedState, matchedIds } = store.resolve(state, [intention.id, "int_unknown"]);
  assert.deepEqual(matchedIds, [intention.id]);
  assert.equal(resolvedState.intentions[0].status, "resolved");
});

test("cancelOnReappearance cancels pending check_in but leaves reminder untouched", () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, {
    type: "check_in", reason: "面试关心", sourceQuote: "面试", dueAt: "2026-08-08T00:00:00.000Z",
  }, { nowIso: NOW_ISO }));
  ({ state } = store.create(state, {
    type: "reminder", reason: "喝水", sourceQuote: "喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO }));

  const { state: nextState, cancelledIds } = store.cancelOnReappearance(state, { types: ["check_in", "resume_topic"] });
  assert.equal(cancelledIds.length, 1);
  const checkIn = nextState.intentions.find((i) => i.type === "check_in");
  const reminder = nextState.intentions.find((i) => i.type === "reminder");
  assert.equal(checkIn.status, "cancelled");
  assert.equal(reminder.status, "pending");
});

test("sweepExpired marks past-expiresAt pending intentions as expired", () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, {
    type: "resume_topic", reason: "老话题", sourceQuote: "老话题",
  }, { nowIso: "2026-01-01T00:00:00.000Z" }));

  const { state: swept, expiredIds } = store.sweepExpired(state, Date.parse("2026-02-01T00:00:00.000Z"));
  assert.equal(expiredIds.length, 1);
  assert.equal(swept.intentions[0].status, "expired");
});

test("selectPendingResumeTopics returns only pending resume_topic entries", () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, { type: "resume_topic", reason: "a", sourceQuote: "a" }, { nowIso: NOW_ISO }));
  ({ state } = store.create(state, {
    type: "reminder", reason: "喝水", sourceQuote: "喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO }));

  assert.equal(store.selectPendingResumeTopics(state).length, 1);
});

test("selectDueForExecution returns only reminder/check_in past their dueAt (fake clock)", () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, {
    type: "reminder", reason: "喝水", sourceQuote: "喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO }));

  assert.equal(store.selectDueForExecution(state, Date.parse("2026-08-06T10:29:00.000Z")).length, 0);
  assert.equal(store.selectDueForExecution(state, Date.parse("2026-08-06T10:30:00.000Z")).length, 1);
});

test("executeDueIntentions never sends when scheduled intentions are disabled (default posture)", async () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, {
    type: "reminder", reason: "喝水", sourceQuote: "喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO }));

  let sent = false;
  const result = await executeDueIntentions({
    store, state, nowMs: Date.parse("2026-08-06T11:00:00.000Z"), enabled: false,
    tryLock: async () => ({ acquired: true, release: () => {} }),
    sendFn: async () => { sent = true; },
  });
  assert.equal(sent, false);
  assert.equal(result.skippedReason, "disabled");
});

test("executeDueIntentions sends and resolves due intentions when enabled, using a fake clock and fake lock", async () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, {
    type: "reminder", reason: "喝水", sourceQuote: "喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO }));

  const sentIds = [];
  let released = false;
  const result = await executeDueIntentions({
    store, state, nowMs: Date.parse("2026-08-06T11:00:00.000Z"), enabled: true,
    tryLock: async () => ({ acquired: true, release: () => { released = true; } }),
    sendFn: async (intention) => { sentIds.push(intention.id); },
  });
  assert.equal(sentIds.length, 1);
  assert.equal(released, true);
  assert.equal(result.state.intentions[0].status, "resolved");
});

test("executeDueIntentions skips (does not send) when the fake lock reports busy", async () => {
  const store = createIntentionsStore(tempConfig());
  let state = store.load();
  ({ state } = store.create(state, {
    type: "reminder", reason: "喝水", sourceQuote: "喝水", dueAt: "2026-08-06T10:30:00.000Z",
  }, { nowIso: NOW_ISO }));

  let sent = false;
  const result = await executeDueIntentions({
    store, state, nowMs: Date.parse("2026-08-06T11:00:00.000Z"), enabled: true,
    tryLock: async () => ({ acquired: false, release: () => {} }),
    sendFn: async () => { sent = true; },
  });
  assert.equal(sent, false);
  assert.equal(result.executed[0].reason, "lock_busy");
  assert.equal(result.state.intentions[0].status, "pending");
});

test("load fails closed on a corrupt file instead of silently resetting", () => {
  const config = tempConfig();
  fs.writeFileSync(config.intentionsFile, "{broken", "utf8");
  const store = createIntentionsStore(config);
  assert.throws(() => store.load(), StateCorruptionError);
});
