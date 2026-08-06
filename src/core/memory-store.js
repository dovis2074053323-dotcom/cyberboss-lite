const crypto = require("crypto");
const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");
const { estimateTokens, MEMORY_INJECTION_TOKEN_BUDGET } = require("./token-estimate");

// Spec §5: conservative two-tier long-term memory. No vector DB, no inferred
// facts, no fuzzy dedupe beyond exact-normalized-match — the whole point of
// "保守型" is to accept less rather than guess.
const CORE_TIER_MAX = 12;
const CONTEXTUAL_TIER_MAX = 30;
const CONTEXTUAL_INJECT_MAX = 8;
const SUPERSEDED_PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_USE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function defaultStoreState() {
  return { memories: [] };
}

function normalizeFact(fact) {
  return String(fact || "").trim().replace(/\s+/g, " ");
}

function createMemoryStore(config) {
  const filePath = config.memoriesFile;

  function load() {
    const raw = readJsonStore(filePath, defaultStoreState);
    const { schemaVersion, updatedAt, ...rest } = raw;
    return { memories: Array.isArray(rest.memories) ? rest.memories : [] };
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, state);
  }

  function activeMemories(state) {
    return state.memories.filter((memory) => memory.status === "active");
  }

  function tierCount(state, tier) {
    return activeMemories(state).filter((memory) => memory.tier === tier).length;
  }

  function findActiveDuplicate(state, { category, tier, fact }) {
    const normalized = normalizeFact(fact);
    return activeMemories(state).find((memory) => (
      memory.category === category && memory.tier === tier && normalizeFact(memory.fact) === normalized
    ));
  }

  // Spec §5 write rules: sourceQuote-verbatim and one-per-turn are enforced
  // upstream by result-schema.js before this is ever called. This layer
  // enforces what only the *store* can know: tier caps and dedupe-by-merge.
  function remember(state, candidate, { nowIso }) {
    const duplicate = findActiveDuplicate(state, candidate);
    if (duplicate) {
      const merged = {
        ...duplicate,
        updatedAt: nowIso,
        lastUsedAt: nowIso,
        tags: Array.from(new Set([...(duplicate.tags || []), ...(candidate.tags || [])])),
      };
      const nextMemories = state.memories.map((memory) => (memory.id === duplicate.id ? merged : memory));
      return { state: { ...state, memories: nextMemories }, outcome: "merged", memory: merged };
    }

    if (tierCount(state, candidate.tier) >= (candidate.tier === "core" ? CORE_TIER_MAX : CONTEXTUAL_TIER_MAX)) {
      return { state, outcome: "rejected_tier_full", memory: null };
    }

    const record = {
      id: `mem_${crypto.randomUUID()}`,
      category: candidate.category,
      fact: candidate.fact,
      tags: Array.isArray(candidate.tags) ? candidate.tags : [],
      tier: candidate.tier,
      confidence: "explicit",
      sourceQuote: candidate.sourceQuote,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastUsedAt: nowIso,
      status: "active",
    };
    return { state: { ...state, memories: [...state.memories, record] }, outcome: "created", memory: record };
  }

  // Spec §5 forget rules (correction / explicit request / expiry) are trusted
  // as already validated by whichever caller decided to forget this id (the
  // model's structured output went through result-schema.js first) — this
  // layer just does the mechanical mark-as-superseded, and treats an unknown
  // or already-inactive id as a silent no-op rather than failing the turn,
  // since a stale/unknown id is not a structural schema violation.
  function forget(state, memoryId, { nowIso }) {
    let matched = false;
    const nextMemories = state.memories.map((memory) => {
      if (memory.id === memoryId && memory.status === "active") {
        matched = true;
        return { ...memory, status: "superseded", updatedAt: nowIso };
      }
      return memory;
    });
    return { state: { ...state, memories: nextMemories }, matched };
  }

  // 30-day physical purge of superseded memories (spec §5). Never runs on
  // active memories regardless of age.
  function purgeSuperseded(state, nowMs) {
    const nextMemories = state.memories.filter((memory) => {
      if (memory.status !== "superseded") {
        return true;
      }
      const updatedMs = Date.parse(memory.updatedAt);
      if (!Number.isFinite(updatedMs)) {
        return true;
      }
      return (nowMs - updatedMs) < SUPERSEDED_PURGE_AFTER_MS;
    });
    return { ...state, memories: nextMemories };
  }

  // Spec §5: core is fully injected every turn; contextual is scored and
  // capped at 8, and the combined injection is budgeted at ~900 estimated
  // tokens. Simple additive scoring, no vector DB.
  function selectForInjection(state, { currentMessageText = "", openLoopSummaries = [], nowMs = Date.now() } = {}) {
    const core = activeMemories(state).filter((memory) => memory.tier === "core");
    const contextualPool = activeMemories(state).filter((memory) => memory.tier === "contextual");

    const scored = contextualPool
      .map((memory) => ({ memory, score: scoreContextualMemory(memory, { currentMessageText, openLoopSummaries, nowMs }) }))
      .sort((a, b) => b.score - a.score || Date.parse(b.memory.lastUsedAt || 0) - Date.parse(a.memory.lastUsedAt || 0));

    let budget = MEMORY_INJECTION_TOKEN_BUDGET - core.reduce((sum, memory) => sum + estimateTokens(memory.fact), 0);
    const contextual = [];
    for (const { memory } of scored) {
      if (contextual.length >= CONTEXTUAL_INJECT_MAX) {
        break;
      }
      const cost = estimateTokens(memory.fact);
      if (cost > budget) {
        continue;
      }
      contextual.push(memory);
      budget -= cost;
    }
    return { core, contextual };
  }

  function markUsed(state, memoryIds, { nowIso }) {
    const idSet = new Set(memoryIds);
    const nextMemories = state.memories.map((memory) => (
      idSet.has(memory.id) ? { ...memory, lastUsedAt: nowIso } : memory
    ));
    return { ...state, memories: nextMemories };
  }

  return {
    load,
    save,
    activeMemories,
    remember,
    forget,
    purgeSuperseded,
    selectForInjection,
    markUsed,
  };
}

function scoreContextualMemory(memory, { currentMessageText, openLoopSummaries, nowMs }) {
  let score = 0;
  const tags = Array.isArray(memory.tags) ? memory.tags : [];

  if (tags.some((tag) => tag && currentMessageText.includes(tag))) {
    score += 3;
  }
  if (tags.some((tag) => tag && openLoopSummaries.some((summary) => summary.includes(tag)))) {
    score += 2;
  }
  if (hasCharOverlap(memory.fact, currentMessageText)) {
    score += 2;
  }
  const lastUsedMs = Date.parse(memory.lastUsedAt || memory.createdAt || 0);
  if (Number.isFinite(lastUsedMs) && (nowMs - lastUsedMs) <= RECENT_USE_WINDOW_MS) {
    score += 1;
  }
  return score;
}

// Crude, dependency-free "topic relevance": any shared 2-character run between
// the fact and the current message. Deliberately simple per spec §5's
// "简单评分，不引入向量数据库".
function hasCharOverlap(fact, currentMessageText) {
  const normalizedFact = normalizeFact(fact);
  if (normalizedFact.length < 2 || !currentMessageText) {
    return false;
  }
  for (let i = 0; i < normalizedFact.length - 1; i += 1) {
    const bigram = normalizedFact.slice(i, i + 2);
    if (bigram.trim().length === 2 && currentMessageText.includes(bigram)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  createMemoryStore,
  CORE_TIER_MAX,
  CONTEXTUAL_TIER_MAX,
  CONTEXTUAL_INJECT_MAX,
  SUPERSEDED_PURGE_AFTER_MS,
};
