const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");
const { estimateTokens, EPISODE_SOFT_TOKEN_LIMIT, EPISODE_HARD_TOKEN_LIMIT } = require("./token-estimate");

// Spec §4: WeChat is always the same window; a bounded episode is the backing
// context unit. Two rollover conditions only — idle (6h) and budget
// (soft 3500 / hard 5000 estimated tokens) — no model call is ever made just to
// summarize.
const IDLE_ROLLOVER_MS = 6 * 60 * 60 * 1000;
const CARRY_FORWARD_TURN_COUNT = 4;

function newEpisodeId() {
  return `episode_${crypto.randomUUID()}`;
}

function emptyEpisode(nowIso, rolloverVersion = 0) {
  return {
    id: newEpisodeId(),
    startedAt: nowIso,
    lastTurnAt: nowIso,
    estimatedTokens: 0,
    messages: [],
    handoff: null,
    rolloverVersion,
  };
}

function recomputeEstimatedTokens(episode) {
  return episode.messages.reduce((sum, message) => sum + estimateTokens(message.text), 0);
}

// "最后 4 个合并 turn": a turn is one merged inbound batch, which can produce a
// user message and (unless the model chose silence) an assistant message. Slice
// from the 4th-from-last *user* message rather than assuming clean user/
// assistant pairing, since a silent turn only appends a user entry.
function trimToLastTurns(messages, turnCount) {
  let userSeen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      userSeen += 1;
      if (userSeen === turnCount) {
        return messages.slice(index);
      }
    }
  }
  return messages.slice();
}

function createEpisodeStore(config) {
  const currentFile = config.episodeCurrentFile;
  const archiveDir = config.episodeArchiveDir;

  function load() {
    const raw = readJsonStore(currentFile, () => null);
    if (!raw) {
      return null;
    }
    const { schemaVersion, updatedAt, ...rest } = raw;
    return rest;
  }

  function save(episode) {
    return writeJsonStoreAtomic(currentFile, episode);
  }

  function archive(episode) {
    fs.mkdirSync(archiveDir, { recursive: true });
    writeJsonStoreAtomic(path.join(archiveDir, `${episode.id}.json`), episode);
  }

  // First-ever run: no current.json yet. Bootstraps and persists a fresh episode.
  function ensureCurrent(nowIso) {
    const existing = load();
    if (existing) {
      return existing;
    }
    const fresh = emptyEpisode(nowIso);
    save(fresh);
    return fresh;
  }

  // Condition A. Must be checked against the *previous* lastTurnAt before this
  // turn's own message is appended.
  function shouldRolloverForIdle(episode, nowMs) {
    const lastTurnMs = Date.parse(episode.lastTurnAt);
    if (!Number.isFinite(lastTurnMs)) {
      return false;
    }
    return (nowMs - lastTurnMs) >= IDLE_ROLLOVER_MS;
  }

  // Condition B, three-way: "none" | "soft" | "hard".
  function budgetStatus(episode) {
    if (episode.estimatedTokens >= EPISODE_HARD_TOKEN_LIMIT) {
      return "hard";
    }
    if (episode.estimatedTokens >= EPISODE_SOFT_TOKEN_LIMIT) {
      return "soft";
    }
    return "none";
  }

  function appendMessage(episode, { role, text, at }) {
    const nextMessages = [...episode.messages, { role, text, at }];
    return {
      ...episode,
      messages: nextMessages,
      estimatedTokens: recomputeEstimatedTokens({ ...episode, messages: nextMessages }),
      lastTurnAt: at,
    };
  }

  // Full rollover: archive the (already-updated, handoff-bearing) episode and
  // start a fresh one. Idempotent via episodeId + rolloverVersion — a caller
  // that already observed this exact version won't double-roll.
  function rolloverEpisode(episode, { nowIso, expectVersion }) {
    // Compare against the on-disk version, not the caller's possibly-stale
    // in-memory copy — that stale copy is exactly what a duplicate/retried
    // rollover call would pass in, so checking it against itself would never
    // catch anything.
    const onDisk = load();
    const currentVersion = onDisk ? onDisk.rolloverVersion : episode.rolloverVersion;
    if (expectVersion !== undefined && currentVersion !== expectVersion) {
      return { episode: onDisk || episode, rolledOver: false };
    }
    archive(episode);
    const fresh = emptyEpisode(nowIso, episode.rolloverVersion + 1);
    save(fresh);
    return { episode: fresh, rolledOver: true };
  }

  // Hard-limit fallback when no valid handoff was produced: same episode
  // continues, but only the last N merged turns' raw text survive.
  function trimEpisode(episode, turnCount = CARRY_FORWARD_TURN_COUNT) {
    const trimmedMessages = trimToLastTurns(episode.messages, turnCount);
    const trimmed = {
      ...episode,
      messages: trimmedMessages,
      estimatedTokens: recomputeEstimatedTokens({ ...episode, messages: trimmedMessages }),
    };
    save(trimmed);
    return trimmed;
  }

  // Spec §4: "一次性" carry context — only meaningful while the new episode has
  // not yet accumulated any live-dialogue messages of its own. No dedicated
  // carry-context field is added to the episode shape (none is listed in spec
  // §2/§4); instead we look up the most recently archived episode by file
  // mtime. This is a best-effort historical read, not part of the fail-closed
  // active-state guarantee: a corrupt/unreadable archive entry just means no
  // carry context is offered this turn, not a startup-blocking failure.
  function loadCarryContext(currentEpisode) {
    if (currentEpisode.messages.length > 0) {
      return null;
    }
    const previous = findMostRecentArchivedEpisode(archiveDir, currentEpisode.id);
    if (!previous) {
      return null;
    }
    if (previous.handoff) {
      return { type: "handoff", handoff: previous.handoff };
    }
    const lastTurns = trimToLastTurns(previous.messages, CARRY_FORWARD_TURN_COUNT);
    if (!lastTurns.length) {
      return null;
    }
    return { type: "lastTurns", messages: lastTurns };
  }

  return {
    load,
    save,
    archive,
    ensureCurrent,
    shouldRolloverForIdle,
    budgetStatus,
    appendMessage,
    rolloverEpisode,
    trimEpisode,
    loadCarryContext,
  };
}

function findMostRecentArchivedEpisode(archiveDir, excludeEpisodeId) {
  let entries;
  try {
    entries = fs.readdirSync(archiveDir);
  } catch {
    return null;
  }
  let bestPath = null;
  let bestMtimeMs = -Infinity;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const id = entry.slice(0, -".json".length);
    if (id === excludeEpisodeId) {
      continue;
    }
    const fullPath = path.join(archiveDir, entry);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.mtimeMs > bestMtimeMs) {
      bestMtimeMs = stat.mtimeMs;
      bestPath = fullPath;
    }
  }
  if (!bestPath) {
    return null;
  }
  try {
    const raw = fs.readFileSync(bestPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  createEpisodeStore,
  emptyEpisode,
  recomputeEstimatedTokens,
  trimToLastTurns,
  IDLE_ROLLOVER_MS,
  CARRY_FORWARD_TURN_COUNT,
};
