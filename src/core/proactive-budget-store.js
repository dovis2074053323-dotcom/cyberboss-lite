const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

const MAX_PROACTIVE_CALLS_PER_DAY = 6;
const MIN_CALL_GAP_MS = 90 * 60 * 1000;
const TARGET_SAFETY_MARGIN_MS = 15 * 60 * 1000;
const RECENT_DAYS_TO_KEEP = 30;

const SLOT_DEFINITIONS = Object.freeze([
  { id: "morning", label: "morning", startHour: 10, startMinute: 0, endHour: 12, endMinute: 30 },
  { id: "afternoon", label: "afternoon", startHour: 15, startMinute: 30, endHour: 18, endMinute: 0 },
  { id: "evening", label: "evening", startHour: 20, startMinute: 30, endHour: 23, endMinute: 0 },
]);

const METRIC_KEYS = [
  "candidatesDetected",
  "candidatesQueued",
  "candidatesSuppressed",
  "modelCalls",
  "optionalCalls",
  "mandatoryCalls",
  "sendMessages",
  "silentDecisions",
  "contextRefreshSuccess",
  "contextRefreshFiltered",
  "contextRefreshTimeout",
  "lockBusy",
  "budgetBlocked",
  "slotsSatisfied",
  "slotsMissed",
];

function emptyMetrics() {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
}

function localDateKey(nowMs) {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildSlots(dateKey, random = Math.random, definitions = SLOT_DEFINITIONS) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const base = new Date(year, month - 1, day);
  return definitions.map((definition) => {
    const start = new Date(base);
    start.setHours(definition.startHour, definition.startMinute, 0, 0);
    const end = new Date(base);
    end.setHours(definition.endHour, definition.endMinute, 0, 0);
    const latestTargetMs = end.getTime() - MIN_CALL_GAP_MS - TARGET_SAFETY_MARGIN_MS;
    if (latestTargetMs < start.getTime()) {
      throw new Error(
        `Invalid proactive slot ${definition.id}: window is too short for a ${MIN_CALL_GAP_MS / 60_000}-minute call gap and ${TARGET_SAFETY_MARGIN_MS / 60_000}-minute target safety margin`,
      );
    }
    const targetRangeMinutes = Math.floor((latestTargetMs - start.getTime()) / 60_000);
    const normalizedRandom = Math.max(0, Math.min(1, Number(random())));
    const offsetMinutes = Math.min(
      targetRangeMinutes,
      Math.floor(normalizedRandom * (targetRangeMinutes + 1)),
    );
    const targetAt = new Date(start.getTime() + offsetMinutes * 60_000);
    return {
      id: definition.id,
      label: definition.label,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      targetAt: targetAt.toISOString(),
      satisfied: false,
      missed: false,
      missReason: null,
      deliveryText: null,
    };
  });
}

function defaultState(dateKey, previous = {}, random = Math.random) {
  return {
    date: dateKey,
    totalCalls: 0,
    optionalCalls: 0,
    forcedCalls: 0,
    lastCallAt: previous.lastCallAt || null,
    slots: buildSlots(dateKey, random),
    ...emptyMetrics(),
    history: Array.isArray(previous.history) ? previous.history.slice(-(RECENT_DAYS_TO_KEEP - 1)) : [],
  };
}

function snapshotForHistory(state, { markUnfinishedMissed = false } = {}) {
  if (!state || typeof state !== "object" || !state.date) return null;
  let slotsMissed = Number.isFinite(Number(state.slotsMissed)) ? Math.max(0, Math.trunc(Number(state.slotsMissed))) : 0;
  const slots = Array.isArray(state.slots)
    ? state.slots.map((slot) => {
      if (markUnfinishedMissed && !slot.satisfied && !slot.missed) {
        slotsMissed += 1;
        return {
          ...slot,
          missed: true,
          missReason: "service_offline_window",
          deliveryText: null,
        };
      }
      return { ...slot, deliveryText: null };
    })
    : [];
  return {
    ...state,
    slots,
    slotsMissed,
    history: undefined,
  };
}

function normalizeCurrentState(raw, dateKey, random) {
  const source = raw && typeof raw === "object" ? raw : {};
  if (source.date !== dateKey) {
    const previous = snapshotForHistory(source, {
      markUnfinishedMissed: typeof source.date === "string" && source.date < dateKey,
    });
    const next = defaultState(dateKey, source, random);
    const history = Array.isArray(source.history) ? source.history.filter(Boolean) : [];
    if (previous) history.push(previous);
    next.history = history.slice(-(RECENT_DAYS_TO_KEEP - 1));
    return next;
  }

  const slots = Array.isArray(source.slots) && source.slots.length === SLOT_DEFINITIONS.length
    ? SLOT_DEFINITIONS.map((definition) => {
      const existing = source.slots.find((slot) => slot && slot.id === definition.id) || {};
      return {
        ...buildSlots(dateKey, () => 0).find((slot) => slot.id === definition.id),
        ...existing,
        id: definition.id,
        label: definition.label,
        satisfied: existing.satisfied === true,
        missed: existing.missed === true,
        missReason: existing.missReason ? String(existing.missReason) : null,
        deliveryText: typeof existing.deliveryText === "string" && existing.deliveryText.trim()
          ? existing.deliveryText
          : null,
      };
    })
    : buildSlots(dateKey, random);

  const next = {
    ...defaultState(dateKey, source, random),
    ...source,
    slots,
    history: Array.isArray(source.history) ? source.history.slice(-(RECENT_DAYS_TO_KEEP - 1)) : [],
  };
  for (const key of ["totalCalls", "optionalCalls", "forcedCalls", ...METRIC_KEYS]) {
    next[key] = Number.isFinite(Number(next[key])) ? Math.max(0, Math.trunc(Number(next[key]))) : 0;
  }
  next.lastCallAt = typeof next.lastCallAt === "string" && next.lastCallAt ? next.lastCallAt : null;
  return next;
}

function elapsedSince(lastCallAt, nowMs) {
  if (!lastCallAt) return null;
  const lastMs = new Date(lastCallAt).getTime();
  if (!Number.isFinite(lastMs)) return null;
  return nowMs - lastMs;
}

function unsatisfiedMandatorySlots(state) {
  return state.slots.filter((slot) => !slot.satisfied && !slot.missed);
}

function callEligibility(state, { forced, nowMs }) {
  if (state.totalCalls >= MAX_PROACTIVE_CALLS_PER_DAY) {
    return { allowed: false, reason: "budget_exhausted", remainingBudget: 0, remainingMandatorySlots: unsatisfiedMandatorySlots(state).length };
  }
  const elapsed = elapsedSince(state.lastCallAt, nowMs);
  if (elapsed !== null && elapsed < MIN_CALL_GAP_MS) {
    return {
      allowed: false,
      reason: "call_gap",
      remainingBudget: MAX_PROACTIVE_CALLS_PER_DAY - state.totalCalls,
      remainingMandatorySlots: unsatisfiedMandatorySlots(state).length,
    };
  }

  const remainingBudget = MAX_PROACTIVE_CALLS_PER_DAY - state.totalCalls;
  const remainingMandatorySlots = unsatisfiedMandatorySlots(state).length;
  if (!forced && remainingBudget <= remainingMandatorySlots) {
    return { allowed: false, reason: "mandatory_budget_reserved", remainingBudget, remainingMandatorySlots };
  }
  return { allowed: true, reason: null, remainingBudget, remainingMandatorySlots };
}

function createProactiveBudgetStore(config, options = {}) {
  const filePath = config.proactiveBudgetFile;
  const nowProvider = options.now || (() => Date.now());
  const random = options.random || Math.random;

  function load(nowMs = nowProvider()) {
    const raw = readJsonStore(filePath, () => ({}));
    const dateKey = localDateKey(nowMs);
    const next = normalizeCurrentState(raw, dateKey, random);
    if (raw.date !== dateKey || !Array.isArray(raw.slots)) {
      writeJsonStoreAtomic(filePath, next);
    }
    return next;
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, state);
  }

  function getOptionalEligibility(nowMs = nowProvider()) {
    const state = load(nowMs);
    return { ...callEligibility(state, { forced: false, nowMs }), state };
  }

  function reserveCall({ forced = false, nowMs = nowProvider() } = {}) {
    const state = load(nowMs);
    const eligibility = callEligibility(state, { forced, nowMs });
    if (!eligibility.allowed) {
      return { ...eligibility, state };
    }
    const next = {
      ...state,
      totalCalls: state.totalCalls + 1,
      forcedCalls: state.forcedCalls + (forced ? 1 : 0),
      modelCalls: state.modelCalls + 1,
      optionalCalls: state.optionalCalls + (forced ? 0 : 1),
      mandatoryCalls: state.mandatoryCalls + (forced ? 1 : 0),
      lastCallAt: new Date(nowMs).toISOString(),
    };
    save(next);
    return {
      ...eligibility,
      allowed: true,
      reserved: true,
      forced: Boolean(forced),
      previousLastCallAt: state.lastCallAt,
      reservedAt: next.lastCallAt,
      state: next,
    };
  }

  function releaseCallReservation(reservation, { nowMs = nowProvider() } = {}) {
    if (!reservation?.reserved || !reservation.reservedAt) {
      return { released: false, state: load(nowMs) };
    }
    const state = load(nowMs);
    // A reservation can only be rolled back while it is still the latest call
    // in this daily state. The host lock normally makes this uncontended; the
    // guard keeps a late error from erasing a subsequent real call.
    if (state.lastCallAt !== reservation.reservedAt || state.totalCalls <= 0) {
      return { released: false, state };
    }
    const next = {
      ...state,
      totalCalls: state.totalCalls - 1,
      forcedCalls: Math.max(0, state.forcedCalls - (reservation.forced ? 1 : 0)),
      modelCalls: Math.max(0, state.modelCalls - 1),
      optionalCalls: Math.max(0, state.optionalCalls - (reservation.forced ? 0 : 1)),
      mandatoryCalls: Math.max(0, state.mandatoryCalls - (reservation.forced ? 1 : 0)),
      lastCallAt: reservation.previousLastCallAt || null,
    };
    save(next);
    return { released: true, state: next };
  }

  function recordMetric(metric, amount = 1, nowMs = nowProvider()) {
    if (!METRIC_KEYS.includes(metric)) return load(nowMs);
    const state = load(nowMs);
    const next = { ...state, [metric]: state[metric] + amount };
    save(next);
    return next;
  }

  function markSlotSatisfied(slotId, nowMs = nowProvider()) {
    const state = load(nowMs);
    const index = state.slots.findIndex((slot) => slot.id === slotId);
    if (index < 0 || state.slots[index].satisfied || state.slots[index].missed) {
      return { state, changed: false };
    }
    const slots = state.slots.map((slot, slotIndex) => slotIndex === index
      ? { ...slot, satisfied: true, deliveryText: null }
      : slot);
    const next = { ...state, slots, slotsSatisfied: state.slotsSatisfied + 1, sendMessages: state.sendMessages + 1 };
    save(next);
    return { state: next, changed: true };
  }

  function markOptionalMessageSent(nowMs = nowProvider()) {
    const state = load(nowMs);
    const slotIndex = state.slots.findIndex((slot) => {
      const start = new Date(slot.startAt).getTime();
      const end = new Date(slot.endAt).getTime();
      return !slot.satisfied && !slot.missed && nowMs >= start && nowMs < end;
    });
    if (slotIndex < 0) {
      const next = { ...state, sendMessages: state.sendMessages + 1 };
      save(next);
      return { state: next, changed: false, slotId: null };
    }
    const slotId = state.slots[slotIndex].id;
    const slots = state.slots.map((slot, index) => index === slotIndex
      ? { ...slot, satisfied: true, deliveryText: null }
      : slot);
    const next = { ...state, slots, slotsSatisfied: state.slotsSatisfied + 1, sendMessages: state.sendMessages + 1 };
    save(next);
    return { state: next, changed: true, slotId };
  }

  function recordDeliveryFailure(slotId, deliveryText, nowMs = nowProvider()) {
    const state = load(nowMs);
    const slots = state.slots.map((slot) => slot.id === slotId && !slot.satisfied && !slot.missed
      ? { ...slot, deliveryText: String(deliveryText || "") }
      : slot);
    const next = { ...state, slots };
    save(next);
    return next;
  }

  function pendingDeliveries(nowMs = nowProvider()) {
    return load(nowMs).slots.filter((slot) => typeof slot.deliveryText === "string" && slot.deliveryText.trim());
  }

  function markExpiredSlots(nowMs = nowProvider()) {
    const state = load(nowMs);
    let missed = 0;
    const slots = state.slots.map((slot) => {
      if (slot.satisfied || slot.missed || nowMs < new Date(slot.endAt).getTime()) return slot;
      missed += 1;
      return { ...slot, missed: true, missReason: "window_ended", deliveryText: null };
    });
    if (!missed) return { state, missed: [] };
    const next = { ...state, slots, slotsMissed: state.slotsMissed + missed };
    save(next);
    return { state: next, missed: slots.filter((slot) => slot.missed && !state.slots.find((old) => old.id === slot.id)?.missed).map((slot) => slot.id) };
  }

  function getSlot(slotId, nowMs = nowProvider()) {
    return load(nowMs).slots.find((slot) => slot.id === slotId) || null;
  }

  return {
    load,
    save,
    getOptionalEligibility,
    reserveCall,
    releaseCallReservation,
    recordMetric,
    markSlotSatisfied,
    markOptionalMessageSent,
    recordDeliveryFailure,
    pendingDeliveries,
    markExpiredSlots,
    getSlot,
    localDateKey,
    maxCallsPerDay: MAX_PROACTIVE_CALLS_PER_DAY,
    minCallGapMs: MIN_CALL_GAP_MS,
    targetSafetyMarginMs: TARGET_SAFETY_MARGIN_MS,
    slotDefinitions: SLOT_DEFINITIONS,
  };
}

module.exports = {
  createProactiveBudgetStore,
  MAX_PROACTIVE_CALLS_PER_DAY,
  MIN_CALL_GAP_MS,
  TARGET_SAFETY_MARGIN_MS,
  SLOT_DEFINITIONS,
  METRIC_KEYS,
  buildSlots,
  localDateKey,
};
