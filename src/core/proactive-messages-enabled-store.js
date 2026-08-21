const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// This is a durable user-owned gate, not an environment override. Missing or
// malformed state is intentionally fail-safe: proactive messages start off.
function defaultState() {
  return { enabled: false };
}

function createProactiveMessagesEnabledStore(config) {
  const filePath = config.proactiveMessagesEnabledFile;

  function load() {
    const raw = readJsonStore(filePath, defaultState);
    return { enabled: raw?.enabled === true };
  }

  function isEnabled() {
    return load().enabled;
  }

  function setEnabled(enabled) {
    const state = { enabled: enabled === true };
    writeJsonStoreAtomic(filePath, state);
    return state;
  }

  return { load, isEnabled, setEnabled };
}

module.exports = { createProactiveMessagesEnabledStore };
