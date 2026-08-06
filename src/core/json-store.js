const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Spec §2: every state file carries { schemaVersion, updatedAt }. Writes go
// through a temp file + atomic rename. On corruption we fail closed — keep the
// file on disk untouched and throw, never silently reset it to a fresh default.
const SCHEMA_VERSION = 1;

class StateCorruptionError extends Error {
  constructor(filePath, cause) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause || "");
    super(`state file is corrupt, refusing to reset: ${filePath}${causeMessage ? ` (${causeMessage})` : ""}`);
    this.name = "StateCorruptionError";
    this.filePath = filePath;
    this.cause = cause;
  }
}

// Returns `createDefault()` only when the file has never been written
// (ENOENT). Any other read/parse/shape failure is corruption, not "empty".
function readJsonStore(filePath, createDefault) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return createDefault();
    }
    throw new StateCorruptionError(filePath, error);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StateCorruptionError(filePath, error);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StateCorruptionError(filePath, new Error("root is not an object"));
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new StateCorruptionError(filePath, new Error(`unexpected schemaVersion ${JSON.stringify(parsed.schemaVersion)}`));
  }
  return parsed;
}

function writeJsonStoreAtomic(filePath, data) {
  const envelope = { ...data, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  return envelope;
}

module.exports = {
  SCHEMA_VERSION,
  StateCorruptionError,
  readJsonStore,
  writeJsonStoreAtomic,
};
