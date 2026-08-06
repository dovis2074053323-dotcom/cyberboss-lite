const { validateStructuredResult } = require("./result-schema");
const { assembleTurnContext } = require("./context-assembler");

// Spec §8: one transactional state coordinator. Two phases:
//
//  - prepareTurn: everything that is true independent of what this turn's
//    model call produces (elapsed real time -> idle rollover, "the user is
//    here now" -> check_in reappearance cancellation) is committed
//    immediately, before the runtime call even happens.
//  - applyTurn: 校验 -> 发送reply -> statePatch -> loops -> memory ->
//    intentions -> handoff/episode, gated entirely on (a) the structured
//    result passing validation and (b) the reply actually being delivered.
//    Either failure means none of applyTurn's own writes happen — "中途失败
//    不得形成半套状态".
function createTurnCoordinator({ currentStateStore, episodeStore, memoryStore, intentionsStore }) {
  async function prepareTurn({ agentName, receivedAtIso, receivedAtLocal, mergedText }) {
    let currentState = currentStateStore.load();
    let episode = episodeStore.ensureCurrent(receivedAtIso);
    let memoryState = memoryStore.load();
    let intentionsState = intentionsStore.load();

    // "The user is here now": check_in's reason for existing (silence) is
    // moot the moment a real message arrives. Committed immediately —
    // independent of whether this turn's own model call succeeds.
    const cancellation = intentionsStore.cancelOnReappearance(intentionsState, { types: ["check_in"] });
    if (cancellation.cancelledIds.length) {
      intentionsState = cancellation.state;
      intentionsStore.save(intentionsState);
    }

    // Idle rollover (condition A) is a fact about elapsed real time, not
    // about this turn's content — commits immediately if due.
    const receivedAtMs = Date.parse(receivedAtIso);
    if (episodeStore.shouldRolloverForIdle(episode, receivedAtMs)) {
      const { episode: rolled } = episodeStore.rolloverEpisode(episode, {
        nowIso: receivedAtIso,
        expectVersion: episode.rolloverVersion,
      });
      episode = rolled;
    }

    const preTurnBudgetStatus = episodeStore.budgetStatus(episode);
    const rolloverRequested = preTurnBudgetStatus !== "none";

    const openLoops = currentStateStore.openLoops(currentState);
    const { core: coreMemories, contextual: contextualMemories } = memoryStore.selectForInjection(memoryState, {
      currentMessageText: mergedText,
      openLoopSummaries: openLoops.map((loop) => loop.summary),
    });
    const carryContext = episodeStore.loadCarryContext(episode);
    const pendingResumeTopics = intentionsStore.selectPendingResumeTopics(intentionsState);

    const turnText = assembleTurnContext({
      agentName,
      nowIso: receivedAtIso,
      coreMemories,
      contextualMemories,
      currentState,
      openLoops,
      carryContext,
      episodeMessages: episode.messages,
      pendingResumeTopics,
      mergedText,
      receivedAtLocal,
      rolloverRequested,
    });

    return {
      turnText,
      episode,
      preTurnBudgetStatus,
      pendingResumeTopicIds: pendingResumeTopics.map((intention) => intention.id),
      usedContextualMemoryIds: contextualMemories.map((memory) => memory.id),
    };
  }

  async function applyTurn({
    structuredResult,
    turnUserText,
    receivedAtIso,
    sourceTurnId,
    prepared,
    sendReply,
  }) {
    const validation = validateStructuredResult(structuredResult, { turnUserText });
    if (!validation.valid) {
      return { applied: false, reason: "invalid_structured_result", errors: validation.errors };
    }

    let delivered = true;
    if (structuredResult.reply) {
      delivered = await sendReply(structuredResult.reply);
    }
    if (!delivered) {
      // Spec §8: whole turn voids — never let the model's belief about state
      // diverge from what the user actually saw.
      return { applied: false, reason: "send_failed" };
    }

    const nowIso = new Date().toISOString();
    let currentState = currentStateStore.load();
    let memoryState = memoryStore.load();
    let intentionsState = intentionsStore.load();
    let episode = prepared.episode;

    currentState = currentStateStore.applyPatch(currentState, structuredResult.statePatch, {
      lastUserMessageAt: receivedAtIso,
      lastAgentMessageAt: structuredResult.reply ? nowIso : undefined,
    });

    for (const loop of structuredResult.loops.add) {
      currentState = currentStateStore.addLoop(currentState, loop);
    }
    for (const loopId of structuredResult.loops.resolve) {
      currentState = currentStateStore.resolveLoop(currentState, loopId);
    }

    if (memoryState.memories.length && prepared.usedContextualMemoryIds.length) {
      memoryState = memoryStore.markUsed(memoryState, prepared.usedContextualMemoryIds, { nowIso });
    }
    for (const candidate of structuredResult.memory.remember) {
      ({ state: memoryState } = memoryStore.remember(memoryState, candidate, { nowIso }));
    }
    for (const memoryId of structuredResult.memory.forget) {
      ({ state: memoryState } = memoryStore.forget(memoryState, memoryId, { nowIso }));
    }

    for (const candidate of structuredResult.intentions.create) {
      ({ state: intentionsState } = intentionsStore.create(intentionsState, candidate, { nowIso, sourceTurnId }));
    }
    const resolveIds = [...structuredResult.intentions.resolve, ...prepared.pendingResumeTopicIds];
    if (resolveIds.length) {
      ({ state: intentionsState } = intentionsStore.resolve(intentionsState, resolveIds));
    }

    episode = episodeStore.appendMessage(episode, { role: "user", text: turnUserText, at: receivedAtIso });
    if (structuredResult.reply) {
      episode = episodeStore.appendMessage(episode, { role: "assistant", text: structuredResult.reply, at: nowIso });
    }

    let rolloverAction = "none";
    if (prepared.preTurnBudgetStatus !== "none" && structuredResult.handoff) {
      episode.handoff = structuredResult.handoff;
      episodeStore.save(episode);
      const rolled = episodeStore.rolloverEpisode(episode, { nowIso, expectVersion: episode.rolloverVersion });
      episode = rolled.episode;
      rolloverAction = rolled.rolledOver ? "rollover" : "none";
    } else if (prepared.preTurnBudgetStatus === "hard") {
      episode = episodeStore.trimEpisode(episode, 4);
      rolloverAction = "trim";
    } else {
      episodeStore.save(episode);
      rolloverAction = prepared.preTurnBudgetStatus === "soft" ? "handoff_requested_not_provided" : "none";
    }

    currentStateStore.save(currentState);
    memoryStore.save(memoryState);
    intentionsStore.save(intentionsState);

    return {
      applied: true,
      reply: structuredResult.reply,
      episodeId: episode.id,
      rolloverAction,
    };
  }

  return { prepareTurn, applyTurn };
}

module.exports = { createTurnCoordinator };
