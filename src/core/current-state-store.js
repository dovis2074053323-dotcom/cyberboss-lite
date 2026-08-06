const crypto = require("crypto");
const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// Spec §2: current-state.json holds both the 5 "current state 允许字段" scalars
// and the open-loops array — the spec lists only one storage file for both, and
// separately restricts what `statePatch` (the model's output) may touch to the
// 5 scalar fields, so open loops live in the same file but are only ever
// mutated through the dedicated add/resolve calls below, never through a patch.
const STATE_PATCH_FIELDS = ["currentActivity", "expectedReturnAt", "recentMood"];

function defaultState() {
  return {
    currentActivity: null,
    expectedReturnAt: null,
    recentMood: null,
    lastUserMessageAt: null,
    lastAgentMessageAt: null,
    openLoops: [],
  };
}

function createCurrentStateStore(config) {
  const filePath = config.currentStateFile;

  function load() {
    const raw = readJsonStore(filePath, defaultState);
    const { schemaVersion, updatedAt, ...rest } = raw;
    return {
      ...defaultState(),
      ...rest,
      openLoops: Array.isArray(rest.openLoops) ? rest.openLoops : [],
    };
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, state);
  }

  // Applies the model's statePatch (only the 3 subjective fields) plus the
  // system-owned event timestamps. lastUserMessageAt/lastAgentMessageAt are
  // never taken from the model's statePatch even though the spec's allowed-
  // field list names them — they are event facts the coordinator itself
  // observed (real inbound receipt / real confirmed outbound send), not
  // something worth trusting a model's clock claim for. See
  // docs/cyberboss-lite-status.md for this interpretation call.
  function applyPatch(state, patch, { lastUserMessageAt, lastAgentMessageAt } = {}) {
    const next = { ...state };
    const source = patch && typeof patch === "object" ? patch : {};
    for (const field of STATE_PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        next[field] = source[field];
      }
    }
    if (lastUserMessageAt !== undefined) {
      next.lastUserMessageAt = lastUserMessageAt;
    }
    if (lastAgentMessageAt !== undefined) {
      next.lastAgentMessageAt = lastAgentMessageAt;
    }
    return next;
  }

  function addLoop(state, { summary, sourceQuote }) {
    const loop = {
      id: `loop_${crypto.randomUUID()}`,
      summary,
      createdAt: new Date().toISOString(),
      sourceQuote,
      status: "open",
    };
    return { ...state, openLoops: [...state.openLoops, loop] };
  }

  function resolveLoop(state, loopId) {
    return {
      ...state,
      openLoops: state.openLoops.map((loop) => (
        loop.id === loopId && loop.status === "open" ? { ...loop, status: "resolved" } : loop
      )),
    };
  }

  function openLoops(state) {
    return state.openLoops.filter((loop) => loop.status === "open");
  }

  return { load, save, applyPatch, addLoop, resolveLoop, openLoops };
}

module.exports = { createCurrentStateStore, defaultState, STATE_PATCH_FIELDS };
