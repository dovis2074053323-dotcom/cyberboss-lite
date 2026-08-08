const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// Persists what Event Opportunity last saw, across ticks and restarts —
// without this, every process restart would treat the first post-restart
// bundle as "all new" and fire immediately. Same atomic-JSON pattern as
// checkin-config-store.js. `snapshot` is event-opportunity-detector.js's
// comparison fingerprint (opaque here); `lastFiredAt` is only used for the
// blanket cooldown, not for per-signal dedupe (that's snapshot's job — see
// the detector's module comment for why the two are separate mechanisms).

function defaultState() {
  return { snapshot: null, lastFiredAt: null };
}

function createEventOpportunityStateStore(config) {
  const filePath = config.eventOpportunityStateFile;

  function load() {
    const raw = readJsonStore(filePath, defaultState);
    const { schemaVersion, updatedAt, ...rest } = raw;
    return { ...defaultState(), ...rest };
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, state);
  }

  return { load, save };
}

module.exports = { createEventOpportunityStateStore };
