const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createEpisodeStore, trimToLastTurns, IDLE_ROLLOVER_MS } = require("../src/core/episode-store");
const { StateCorruptionError } = require("../src/core/json-store");
const { EPISODE_SOFT_TOKEN_LIMIT, EPISODE_HARD_TOKEN_LIMIT, estimateTokens } = require("../src/core/token-estimate");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-episode-test-"));
  return {
    episodeCurrentFile: path.join(dir, "episodes", "current.json"),
    episodeArchiveDir: path.join(dir, "episodes", "archive"),
  };
}

test("ensureCurrent bootstraps a fresh episode on first run and persists it", () => {
  const config = tempConfig();
  const store = createEpisodeStore(config);
  assert.equal(store.load(), null);

  const episode = store.ensureCurrent("2026-08-06T10:00:00.000Z");
  assert.match(episode.id, /^episode_/);
  assert.equal(episode.rolloverVersion, 0);
  assert.deepEqual(episode.messages, []);
  assert.deepEqual(store.load(), episode);
});

test("shouldRolloverForIdle is false under 6h and true at/over 6h", () => {
  const store = createEpisodeStore(tempConfig());
  const episode = store.ensureCurrent("2026-08-06T10:00:00.000Z");
  const lastTurnMs = Date.parse(episode.lastTurnAt);

  assert.equal(store.shouldRolloverForIdle(episode, lastTurnMs + IDLE_ROLLOVER_MS - 1), false);
  assert.equal(store.shouldRolloverForIdle(episode, lastTurnMs + IDLE_ROLLOVER_MS), true);
});

test("budgetStatus reports none/soft/hard at the exact thresholds", () => {
  const store = createEpisodeStore(tempConfig());
  const base = store.ensureCurrent("2026-08-06T10:00:00.000Z");

  assert.equal(store.budgetStatus({ ...base, estimatedTokens: EPISODE_SOFT_TOKEN_LIMIT - 1 }), "none");
  assert.equal(store.budgetStatus({ ...base, estimatedTokens: EPISODE_SOFT_TOKEN_LIMIT }), "soft");
  assert.equal(store.budgetStatus({ ...base, estimatedTokens: EPISODE_HARD_TOKEN_LIMIT - 1 }), "soft");
  assert.equal(store.budgetStatus({ ...base, estimatedTokens: EPISODE_HARD_TOKEN_LIMIT }), "hard");
});

test("appendMessage grows estimatedTokens by the shared token estimate", () => {
  const store = createEpisodeStore(tempConfig());
  let episode = store.ensureCurrent("2026-08-06T10:00:00.000Z");
  episode = store.appendMessage(episode, { role: "user", text: "你好", at: "2026-08-06T10:00:01.000Z" });
  assert.equal(episode.messages.length, 1);
  assert.equal(episode.estimatedTokens, estimateTokens("你好"));
  assert.equal(episode.lastTurnAt, "2026-08-06T10:00:01.000Z");
});

test("50 consecutive merged turns do not grow estimatedTokens linearly forever once hard-trimmed each time", () => {
  const store = createEpisodeStore(tempConfig());
  let episode = store.ensureCurrent("2026-08-06T00:00:00.000Z");
  const bigChunk = "字".repeat(600); // ~600 estimated tokens per turn pair

  for (let turn = 0; turn < 50; turn += 1) {
    const at = `2026-08-06T00:${String(turn % 60).padStart(2, "0")}:00.000Z`;
    episode = store.appendMessage(episode, { role: "user", text: bigChunk, at });
    episode = store.appendMessage(episode, { role: "assistant", text: bigChunk, at });
    if (store.budgetStatus(episode) === "hard") {
      episode = store.trimEpisode(episode, 4);
    }
  }

  // Trimmed down to at most 4 turns (<=8 messages) worth of tokens, not ~50
  // turns' worth — proves the hard-limit trim actually bounds growth.
  assert.ok(episode.messages.length <= 8, `expected <=8 messages, got ${episode.messages.length}`);
  assert.ok(episode.estimatedTokens < EPISODE_HARD_TOKEN_LIMIT * 2);
});

test("trimToLastTurns keeps the last N *user* turns even when some turns were silent (user-only)", () => {
  const messages = [
    { role: "user", text: "1", at: "t1" },
    { role: "assistant", text: "a1", at: "t1" },
    { role: "user", text: "2", at: "t2" }, // silent turn, no assistant reply
    { role: "user", text: "3", at: "t3" },
    { role: "assistant", text: "a3", at: "t3" },
    { role: "user", text: "4", at: "t4" },
    { role: "assistant", text: "a4", at: "t4" },
  ];
  const trimmed = trimToLastTurns(messages, 2);
  assert.deepEqual(trimmed.map((m) => m.text), ["3", "a3", "4", "a4"]);
});

test("rolloverEpisode archives the old episode and starts a fresh versioned one", () => {
  const config = tempConfig();
  const store = createEpisodeStore(config);
  let episode = store.ensureCurrent("2026-08-06T10:00:00.000Z");
  episode = store.appendMessage(episode, { role: "user", text: "hi", at: "2026-08-06T10:00:01.000Z" });
  const oldId = episode.id;
  episode.handoff = { summary: "概要", tone: "轻松", openLoops: [], carryForward: [] };
  store.save(episode);

  const { episode: fresh, rolledOver } = store.rolloverEpisode(episode, { nowIso: "2026-08-06T16:00:01.000Z" });
  assert.equal(rolledOver, true);
  assert.notEqual(fresh.id, oldId);
  assert.equal(fresh.rolloverVersion, 1);
  assert.deepEqual(fresh.messages, []);
  assert.deepEqual(store.load(), fresh);

  const archivedPath = path.join(config.episodeArchiveDir, `${oldId}.json`);
  const archived = JSON.parse(fs.readFileSync(archivedPath, "utf8"));
  assert.equal(archived.id, oldId);
  assert.equal(archived.handoff.summary, "概要");
});

test("rolloverEpisode is idempotent: a stale expectVersion call is a no-op", () => {
  const config = tempConfig();
  const store = createEpisodeStore(config);
  const episode = store.ensureCurrent("2026-08-06T10:00:00.000Z");
  const first = store.rolloverEpisode(episode, { nowIso: "2026-08-06T16:00:00.000Z", expectVersion: 0 });
  assert.equal(first.rolledOver, true);

  // Retry with the same (now-stale) expectVersion: must not roll over again.
  const second = store.rolloverEpisode(episode, { nowIso: "2026-08-06T16:00:01.000Z", expectVersion: 0 });
  assert.equal(second.rolledOver, false);
  assert.equal(second.episode.id, first.episode.id);
});

test("loadCarryContext returns the previous episode's handoff when present, only while the new episode is empty", () => {
  const config = tempConfig();
  const store = createEpisodeStore(config);
  let episode = store.ensureCurrent("2026-08-06T10:00:00.000Z");
  episode.handoff = { summary: "s", tone: "t", openLoops: [], carryForward: [] };
  store.save(episode);
  const { episode: fresh } = store.rolloverEpisode(episode, { nowIso: "2026-08-06T16:00:00.000Z" });

  const carry = store.loadCarryContext(fresh);
  assert.equal(carry.type, "handoff");
  assert.equal(carry.handoff.summary, "s");

  const afterFirstTurn = store.appendMessage(fresh, { role: "user", text: "hi", at: "2026-08-06T16:00:01.000Z" });
  assert.equal(store.loadCarryContext(afterFirstTurn), null);
});

test("loadCarryContext falls back to the previous episode's last 4 turns when it has no handoff", () => {
  const config = tempConfig();
  const store = createEpisodeStore(config);
  let episode = store.ensureCurrent("2026-08-06T10:00:00.000Z");
  for (let i = 0; i < 6; i += 1) {
    episode = store.appendMessage(episode, { role: "user", text: `u${i}`, at: `2026-08-06T10:0${i}:00.000Z` });
    episode = store.appendMessage(episode, { role: "assistant", text: `a${i}`, at: `2026-08-06T10:0${i}:01.000Z` });
  }
  store.save(episode);
  const { episode: fresh } = store.rolloverEpisode(episode, { nowIso: "2026-08-06T16:00:00.000Z" });

  const carry = store.loadCarryContext(fresh);
  assert.equal(carry.type, "lastTurns");
  assert.deepEqual(carry.messages.map((m) => m.text), ["u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5"]);
});

test("load fails closed on a corrupt current.json instead of silently resetting", () => {
  const config = tempConfig();
  fs.mkdirSync(path.dirname(config.episodeCurrentFile), { recursive: true });
  fs.writeFileSync(config.episodeCurrentFile, "not json", "utf8");
  const store = createEpisodeStore(config);
  assert.throws(() => store.load(), StateCorruptionError);
});
