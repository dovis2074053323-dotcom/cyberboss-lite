const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// Persists the observation fingerprint plus the rolling local evidence
// accumulator. Keeping both in this existing state file means a restart does
// not turn the first post-restart poll into a fake event, and no parallel
// observation store is introduced for proactive scheduling.

function defaultState() {
  return {
    snapshot: null,
    lastFiredAt: null,
    evidence: [],
    pendingEnvironment: null,
    candidate: null,
  };
}

function createEventOpportunityStateStore(config) {
  const filePath = config.eventOpportunityStateFile;

  function load() {
    const raw = readJsonStore(filePath, defaultState);
    const { schemaVersion, updatedAt, ...rest } = raw;
    return {
      ...defaultState(),
      ...rest,
      evidence: Array.isArray(rest.evidence) ? rest.evidence : [],
      pendingEnvironment: rest.pendingEnvironment && typeof rest.pendingEnvironment === "object"
        ? rest.pendingEnvironment
        : null,
      candidate: rest.candidate && typeof rest.candidate === "object" ? rest.candidate : null,
    };
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, state);
  }

  return { load, save };
}

module.exports = { createEventOpportunityStateStore };
