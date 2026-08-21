const fs = require("fs");
const path = require("path");
const { normalizeAccountId } = require("./account-store");

function resolveSyncBufferPath(config, accountId) {
  fs.mkdirSync(config.syncBufferDir, { recursive: true });
  return path.join(config.syncBufferDir, `${normalizeAccountId(accountId)}.txt`);
}

function loadSyncBuffer(config, accountId) {
  try {
    return fs.readFileSync(resolveSyncBufferPath(config, accountId), "utf8").trim();
  } catch {
    return "";
  }
}

function saveSyncBuffer(config, accountId, buffer) {
  fs.writeFileSync(resolveSyncBufferPath(config, accountId), String(buffer || ""), "utf8");
}

module.exports = { loadSyncBuffer, resolveSyncBufferPath, saveSyncBuffer };
