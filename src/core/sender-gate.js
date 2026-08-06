const fs = require("fs");
const path = require("path");

// Spec 五: bootstrap mode records the first sender ID and stops (no Claude call).
// Once recorded (or set via CYBERBOSS_ALLOWED_SENDER_ID), only that sender is admitted.
function createSenderGate(config) {
  let allowedSenderId = normalizeText(config.allowedSenderId) || readPersistedSenderId(config.senderAllowlistFile);

  return {
    getAllowedSenderId() {
      return allowedSenderId;
    },
    // Returns "admit" | "bootstrap_captured" | "rejected"
    evaluate(senderId) {
      const normalized = normalizeText(senderId);
      if (!normalized) {
        return "rejected";
      }
      if (!allowedSenderId) {
        allowedSenderId = normalized;
        persistSenderId(config.senderAllowlistFile, normalized);
        return "bootstrap_captured";
      }
      return normalized === allowedSenderId ? "admit" : "rejected";
    },
  };
}

function readPersistedSenderId(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeText(parsed?.senderId);
  } catch {
    return "";
  }
}

function persistSenderId(filePath, senderId) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ senderId, capturedAt: new Date().toISOString() }, null, 2), "utf8");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { createSenderGate };
