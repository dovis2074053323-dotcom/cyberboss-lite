const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createProactiveBudgetStore } = require("../src/core/proactive-budget-store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-budget-test-"));
  return { proactiveBudgetFile: path.join(dir, "proactive-budget.json") };
}

const DAY1 = new Date("2026-08-11T02:00:00Z").getTime();
const GAP = 90 * 60 * 1000;

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
  const released = store.releaseCallReservation(reservation);

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
