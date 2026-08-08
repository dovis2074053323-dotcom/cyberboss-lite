const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// Ported from upstream WenXiaoWendy/cyberboss's system-message-queue-store.js,
// simplified for Lite's single-account model — upstream routed queued
// messages by accountId across multiple WeChat accounts; Lite has exactly one
// sender allowlist entry (config.allowedSenderId), so that dimension is
// dropped here in favor of a flat FIFO.
//
// Holds queued proactive triggers (Stochastic Pulse wake-ups, and — once
// Event Opportunity ships next session — its wake-ups too) until the next
// turn-execution pass drains and processes them. hasPending() is the guard
// pollers use to avoid stacking a new wake-up on top of one that hasn't been
// consumed yet (mirrors upstream's "skip if queue not empty" behavior).

function defaultStoreState() {
  return { messages: [] };
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const id = String(message.id || "").trim();
  const source = String(message.source || "").trim();
  const createdAt = String(message.createdAt || "").trim();
  if (!id || !source || !createdAt) {
    return null;
  }
  return {
    id,
    source, // "stochastic_pulse" | "event_opportunity" (session 4)
    createdAt,
    bundle: message.bundle && typeof message.bundle === "object" ? message.bundle : {},
  };
}

function createSystemMessageQueueStore(config) {
  const filePath = config.systemMessageQueueFile;

  function load() {
    const raw = readJsonStore(filePath, defaultStoreState);
    const { schemaVersion, updatedAt, ...rest } = raw;
    return { messages: Array.isArray(rest.messages) ? rest.messages : [] };
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, state);
  }

  function enqueue(state, message) {
    const normalized = normalizeMessage(message);
    if (!normalized) {
      throw new Error("system-message-queue: invalid message");
    }
    return { ...state, messages: [...state.messages, normalized] };
  }

  function hasPending(state) {
    return state.messages.length > 0;
  }

  function drainAll(state) {
    return { drained: state.messages, state: { ...state, messages: [] } };
  }

  return { load, save, enqueue, hasPending, drainAll };
}

module.exports = { createSystemMessageQueueStore };
