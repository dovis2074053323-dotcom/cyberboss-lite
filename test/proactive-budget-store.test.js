const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createProactiveBudgetStore,
  buildSlots,
  MIN_CALL_GAP_MS,
  TARGET_SAFETY_MARGIN_MS,
} = require("../src/core/proactive-budget-store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-budget-test-"));
  return { proactiveBudgetFile: path.join(dir, "proactive-budget.json") };
}

const DAY1 = new Date("2026-08-11T02:00:00Z").getTime();
const GAP = 90 * 60 * 1000;

test("targets stay inside every slot's safe range and random endpoints are bounded", () => {
  const atStart = buildSlots("2026-08-11", () => 0);
  const atLatest = buildSlots("2026-08-11", () => 1);

  assert.equal(atStart.length, 3);
  for (const [index, slot] of atStart.entries()) {
    const startMs = new Date(slot.startAt).getTime();
    const endMs = new Date(slot.endAt).getTime();
    const latestTargetMs = endMs - MIN_CALL_GAP_MS - TARGET_SAFETY_MARGIN_MS;
    assert.equal(new Date(slot.targetAt).getTime(), startMs);
    assert.ok(new Date(atLatest[index].targetAt).getTime() <= latestTargetMs);
    assert.ok(new Date(atLatest[index].targetAt).getTime() >= startMs);
  }
});

test("a slot that cannot contain the gap and safety margin fails fast", () => {
  assert.throws(
    () => buildSlots("2026-08-11", () => 0, [{
      id: "too-short",
      label: "too-short",
      startHour: 10,
      startMinute: 0,
      endHour: 11,
      endMinute: 44,
    }]),
    /Invalid proactive slot too-short: window is too short/,
  );
});

test("a new day creates three persisted random target times", () => {
  const config = tempConfig();
  const first = createProactiveBudgetStore(config, { random: () => 0.25 });
  const initial = first.load(DAY1);
  assert.equal(initial.slots.length, 3);
  assert.equal(initial.date, new Date(DAY1).toISOString().slice(0, 10));

  const restarted = createProactiveBudgetStore(config, { random: () => 0.9 });
  const sameDay = restarted.load(DAY1 + 60_000);
  assert.deepEqual(sameDay.slots.map((slot) => slot.targetAt), initial.slots.map((slot) => slot.targetAt));
});

test("target generation waits for the daily reset before drawing new targets", () => {
  const config = tempConfig();
  let randomValue = 0;
  const store = createProactiveBudgetStore(config, {
    random: () => randomValue,
  });

  const firstDay = store.load(DAY1);
  randomValue = 1;
  const sameDay = store.load(DAY1 + 60_000);
  assert.deepEqual(sameDay.slots.map((slot) => slot.targetAt), firstDay.slots.map((slot) => slot.targetAt));
  const nextDay = store.load(DAY1 + 24 * 60 * 60 * 1000);
  for (const slot of nextDay.slots) {
    const endMs = new Date(slot.endAt).getTime();
    const latestTargetMs = endMs - MIN_CALL_GAP_MS - TARGET_SAFETY_MARGIN_MS;
    assert.equal(new Date(slot.targetAt).getTime(), latestTargetMs);
  }
});

test("a silent optional call immediately before target leaves the full gap inside the slot", () => {
  const store = createProactiveBudgetStore(tempConfig(), { random: () => 1 });
  const slot = store.load(DAY1).slots[0];
  const targetMs = new Date(slot.targetAt).getTime();
  const optionalAt = targetMs - 1;
  const forcedAt = optionalAt + MIN_CALL_GAP_MS;

  assert.equal(store.reserveCall({ nowMs: optionalAt }).allowed, true);
  assert.ok(forcedAt >= targetMs);
  assert.ok(forcedAt < new Date(slot.endAt).getTime());
  assert.equal(store.reserveCall({ forced: true, nowMs: forcedAt }).allowed, true);
});

test("forced reservations have a hard six-call daily cap", () => {
  const store = createProactiveBudgetStore(tempConfig());
  let now = DAY1;
  for (let i = 0; i < 6; i += 1) {
    const result = store.reserveCall({ forced: true, nowMs: now });
    assert.equal(result.allowed, true, `call ${i + 1}`);
    now += GAP;
  }
  const seventh = store.reserveCall({ forced: true, nowMs: now });
  assert.equal(seventh.allowed, false);
  assert.equal(seventh.reason, "budget_exhausted");
  assert.equal(store.load(now).totalCalls, 6);
});

test("optional calls stop when the three unsatisfied mandatory slots need the remaining budget", () => {
  const store = createProactiveBudgetStore(tempConfig());
  let now = DAY1;
  assert.equal(store.reserveCall({ nowMs: now }).allowed, true);
  now += GAP;
  assert.equal(store.reserveCall({ nowMs: now }).allowed, true);
  now += GAP;
  assert.equal(store.reserveCall({ nowMs: now }).allowed, true);
  now += GAP;
  const blocked = store.reserveCall({ nowMs: now });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "mandatory_budget_reserved");
});

test("all proactive calls respect the 90-minute gap", () => {
  const store = createProactiveBudgetStore(tempConfig());
  assert.equal(store.reserveCall({ forced: true, nowMs: DAY1 }).allowed, true);
  const tooSoon = store.reserveCall({ forced: true, nowMs: DAY1 + GAP - 1 });
  assert.equal(tooSoon.allowed, false);
  assert.equal(tooSoon.reason, "call_gap");
  assert.equal(store.reserveCall({ forced: true, nowMs: DAY1 + GAP }).allowed, true);
});

test("date rollover resets daily calls and does not replay yesterday's slots", () => {
  const config = tempConfig();
  const store = createProactiveBudgetStore(config);
  const yesterday = store.load(DAY1);
  store.reserveCall({ forced: true, nowMs: DAY1 });
  const tomorrow = store.load(DAY1 + 24 * 60 * 60 * 1000);

  assert.notEqual(tomorrow.date, yesterday.date);
  assert.equal(tomorrow.totalCalls, 0);
  assert.equal(tomorrow.slots.every((slot) => !slot.satisfied && !slot.missed), true);
  assert.equal(tomorrow.history.length, 1);
  // Keep the cross-midnight cooldown even though the daily counter reset.
  assert.equal(tomorrow.lastCallAt, new Date(DAY1).toISOString());
});

test("date rollover records unfinished previous-day slots as offline misses", () => {
  const config = tempConfig();
  const store = createProactiveBudgetStore(config);
  store.load(DAY1);
  const tomorrow = store.load(DAY1 + 24 * 60 * 60 * 1000);
  const previous = tomorrow.history[0];

  assert.equal(previous.slots.every((slot) => slot.missed === true), true);
  assert.equal(previous.slots.every((slot) => slot.missReason === "service_offline_window"), true);
  assert.equal(previous.slotsMissed, 3);
  assert.equal(tomorrow.slots.every((slot) => !slot.missed), true);
});

test("a pre-runtime reservation can be released without leaving a phantom call", () => {
  const store = createProactiveBudgetStore(tempConfig());
  const reservation = store.reserveCall({ nowMs: DAY1 });
  assert.equal(reservation.allowed, true);
  const released = store.releaseCallReservation(reservation, { nowMs: DAY1 });

  assert.equal(released.released, true);
  assert.equal(store.load(DAY1).totalCalls, 0);
  assert.equal(store.load(DAY1).modelCalls, 0);
  assert.equal(store.load(DAY1).lastCallAt, null);
});

test("mandatory delivery failure is persisted for a pure retry and satisfies only after success", () => {
  const store = createProactiveBudgetStore(tempConfig());
  const slot = store.load(DAY1).slots[0];
  store.recordDeliveryFailure(slot.id, "hello", DAY1);
  assert.equal(store.pendingDeliveries(DAY1)[0].deliveryText, "hello");
  const result = store.markSlotSatisfied(slot.id, DAY1);
  assert.equal(result.changed, true);
  assert.equal(store.pendingDeliveries(DAY1).length, 0);
  assert.equal(store.getSlot(slot.id, DAY1).satisfied, true);
});
