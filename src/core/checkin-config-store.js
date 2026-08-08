const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// Ported from upstream WenXiaoWendy/cyberboss's checkin-config-store.js.
// Persists an operator override for the Stochastic Pulse's random interval
// range; falls back to config.checkinMinIntervalMs/checkinMaxIntervalMs
// (env-set, default 3m-60m matching upstream) when no override was ever saved.

function defaultStoreState() {
  return {};
}

function normalizeRange(value) {
  const minIntervalMs = Number.parseInt(value?.minIntervalMs, 10);
  const maxIntervalMs = Number.parseInt(value?.maxIntervalMs, 10);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) {
    return null;
  }
  if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0) {
    return null;
  }
  return { minIntervalMs, maxIntervalMs: Math.max(minIntervalMs, maxIntervalMs) };
}

function createCheckinConfigStore(config) {
  const filePath = config.checkinConfigFile;
  const fallbackRange = {
    minIntervalMs: config.checkinMinIntervalMs,
    maxIntervalMs: config.checkinMaxIntervalMs,
  };

  function getRange() {
    const raw = readJsonStore(filePath, defaultStoreState);
    return normalizeRange(raw) || fallbackRange;
  }

  function setRange(range) {
    const normalized = normalizeRange(range);
    if (!normalized) {
      throw new Error("checkin-config: invalid range");
    }
    writeJsonStoreAtomic(filePath, normalized);
    return normalized;
  }

  return { getRange, setRange };
}

module.exports = { createCheckinConfigStore };
