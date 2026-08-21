const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// One small FIFO is shared by event candidates and mandatory outreach slots.
// New records intentionally contain no observation bundle: the drain rebuilds
// the bundle after taking the host lock. `bundle` is retained only while
// normalizing old on-disk records so a deployment can migrate without losing
// or rewriting user state in place.

function defaultStoreState() {
  return { messages: [] };
}

const SYSTEM_MESSAGE_SOURCES = Object.freeze([
  "checkin",
  "location",
  "reminder",
  "event_opportunity",
  "mandatory_slot",
  "stochastic_pulse",
  "legacy",
]);

function inferLegacySource(id) {
  const value = String(id || "").trim().toLowerCase();
  if (/remind(?:er)?|intention/.test(value)) return "reminder";
  if (/location|movement|geofence|geo/.test(value)) return "location";
  if (/check[ _-]?in|stochastic|pulse/.test(value)) return "checkin";
  // Unknown old records are proactive by default. It is safer to discard an
  // ambiguous active candidate on OFF than to deliver it after the user closed
  // the master gate.
  return "legacy";
}

function normalizeMessage(message, { allowLegacySource = false } = {}) {
  if (!message || typeof message !== "object") return null;
  const id = String(message.id || "").trim();
  const rawSource = String(message.source || "").trim();
  const source = rawSource || (allowLegacySource ? inferLegacySource(id) : "");
  const createdAt = String(message.createdAt || "").trim();
  if (!id || !source || !createdAt) return null;
  const normalized = {
    id,
    source,
    createdAt,
    forced: message.forced === true || source === "mandatory_slot",
    slotId: message.slotId ? String(message.slotId) : null,
    reasons: Array.isArray(message.reasons) ? message.reasons.map(String).slice(0, 8) : [],
    evidenceScore: Number.isFinite(Number(message.evidenceScore)) ? Number(message.evidenceScore) : 0,
  };
  if (message.bundle && typeof message.bundle === "object") {
    normalized.bundle = message.bundle;
    normalized.legacyFrozenBundle = true;
  }
  return normalized;
}

function createSystemMessageQueueStore(config) {
  const filePath = config.systemMessageQueueFile;

  function load() {
    const raw = readJsonStore(filePath, defaultStoreState);
    const { schemaVersion, updatedAt, ...rest } = raw;
    const messages = Array.isArray(rest.messages)
      ? rest.messages.map((message) => normalizeMessage(message, { allowLegacySource: true })).filter(Boolean)
      : [];
    return { messages };
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, { messages: Array.isArray(state?.messages) ? state.messages : [] });
  }

  function enqueue(state, message) {
    const normalized = normalizeMessage(message);
    if (!normalized) throw new Error("system-message-queue: invalid message");
    return { ...state, messages: [...state.messages, normalized] };
  }

  function hasPending(state) {
    return Array.isArray(state?.messages) && state.messages.length > 0;
  }

  function peek(state) {
    return state?.messages?.[0] || null;
  }

  function takeFirst(state) {
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    return { message: messages[0] || null, state: { ...state, messages: messages.slice(1) } };
  }

  function replaceFirst(state, message) {
    const normalized = normalizeMessage(message);
    if (!normalized) throw new Error("system-message-queue: invalid replacement");
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    return { ...state, messages: [normalized, ...messages.slice(1)] };
  }

  function removeWhere(state, predicate) {
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    return { ...state, messages: messages.filter((message) => !predicate(message)) };
  }

  function drainAll(state) {
    return { drained: Array.isArray(state?.messages) ? state.messages : [], state: { ...state, messages: [] } };
  }

  return {
    load,
    save,
    enqueue,
    hasPending,
    peek,
    takeFirst,
    replaceFirst,
    removeWhere,
    drainAll,
    normalizeMessage,
    inferLegacySource,
    sources: SYSTEM_MESSAGE_SOURCES,
  };
}

module.exports = { createSystemMessageQueueStore, normalizeMessage, inferLegacySource, SYSTEM_MESSAGE_SOURCES };
