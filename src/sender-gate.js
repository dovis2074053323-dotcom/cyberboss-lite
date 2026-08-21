const fs = require("fs");
const path = require("path");

function createSenderGate(config) {
  let allowedSenderId = normalizeText(config.allowedSenderId) || readPersistedSenderId(config.senderAllowlistFile);

  return {
    getAllowedSenderId() {
      return allowedSenderId;
    },
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
    return normalizeText(JSON.parse(fs.readFileSync(filePath, "utf8")).senderId);
  } catch {
    return "";
  }
}

function persistSenderId(filePath, senderId) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    senderId,
    capturedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort.
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { createSenderGate };
