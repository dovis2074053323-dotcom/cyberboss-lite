const crypto = require("crypto");

const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_ITEM_TEXT = 1;
const DEDUP_TTL_MS = 5 * 60_000;

function createInboundFilter({ now = () => Date.now(), ttlMs = DEDUP_TTL_MS } = {}) {
  const seen = new Map();

  return {
    normalize(message, config, accountId) {
      if (!message || typeof message !== "object") {
        return null;
      }

      const messageType = Number(message.message_type);
      if (messageType === MESSAGE_TYPE_BOT || (messageType !== 0 && messageType !== MESSAGE_TYPE_USER)) {
        return null;
      }

      const senderId = normalizeText(message.from_user_id);
      const contextToken = normalizeText(message.context_token);
      const text = extractText(message.item_list);
      if (!senderId || !contextToken || !text) {
        return null;
      }

      const createdAtMs = normalizeTimestampMs(message);
      const dedupeKey = buildDedupKey(message, senderId, contextToken, text, createdAtMs);
      pruneSeen(seen, now(), ttlMs);
      if (seen.has(dedupeKey)) {
        return null;
      }
      seen.set(dedupeKey, now());

      return {
        accountId,
        senderId,
        text,
        contextToken,
        messageId: normalizeText(message.message_id),
        receivedAt: createdAtMs > 0 ? new Date(createdAtMs).toISOString() : new Date(now()).toISOString(),
      };
    },
  };
}

function extractText(itemList) {
  if (!Array.isArray(itemList)) {
    return "";
  }
  for (const item of itemList) {
    if (Number(item?.type) !== MESSAGE_ITEM_TEXT) {
      continue;
    }
    const text = normalizeText(item?.text_item?.text);
    if (text) {
      return text;
    }
  }
  return "";
}

function buildDedupKey(message, senderId, contextToken, text, createdAtMs) {
  const explicit = [message.message_id, message.client_id, message.seq]
    .map(normalizeText)
    .find(Boolean);
  if (explicit) {
    return `${senderId}|${explicit}`;
  }
  return crypto.createHash("sha256")
    .update(JSON.stringify([senderId, contextToken, text, createdAtMs || 0]))
    .digest("hex");
}

function pruneSeen(seen, now, ttlMs) {
  for (const [key, seenAt] of seen) {
    if (now - seenAt > ttlMs) {
      seen.delete(key);
    }
  }
}

function normalizeTimestampMs(message) {
  const milliseconds = Number(message?.create_time_ms);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return milliseconds;
  }
  const seconds = Number(message?.create_time);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function normalizeText(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEDUP_TTL_MS,
  MESSAGE_ITEM_TEXT,
  MESSAGE_TYPE_BOT,
  MESSAGE_TYPE_USER,
  createInboundFilter,
  extractText,
};
