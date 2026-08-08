const { evaluateStructuredResult } = require("./result-schema");
const { assembleTurnContext } = require("./context-assembler");

// Used only when the structured result is fatally malformed (evaluateStructuredResult
// couldn't even trust `reply`) — a fixed, non-model string, never derived from
// anything the model produced this turn.
const FATAL_FALLBACK_REPLY = "抱歉，这轮我这边处理出了点问题，内容没能正常生成，你可以再说一次。";

// A create candidate that fails — whether at the schema layer (bad shape/
// ungrounded sourceQuote) or the store's own business rules (bad dueAt,
// pending cap full) — is, by construction, something the user explicitly
// asked for (every candidate must carry a sourceQuote grounded in this turn's
// text). Silence or a falsely-confident reply are both worse than a short,
// clearly-marked notice.
function describeIntentionFailure(failure) {
  const detail = String(failure.detail || "");
  if (/dueAt/i.test(detail)) {
    return "时间没识别对（可能已经过去，或者格式不对）";
  }
  if (failure.outcome === "rejected_pending_cap") {
    return "待处理的提醒/事项已经排满了";
  }
  if (failure.outcome === "invalid_schema") {
    return "内容没有对应上这轮你说的原话";
  }
  return "没有成功记录下来";
}

function buildIntentionFailureNotice(failures) {
  const reasonText = describeIntentionFailure(failures[0]);
  return `⚠️ 提醒/日程没有设置成功（${reasonText}），需要的话请再说一遍。`;
}

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
    const diagnostics = [];
    const evaluation = evaluateStructuredResult(structuredResult, { turnUserText });

    // The user's own message is a fact regardless of what this turn's model
    // output looked like — recorded unconditionally, before any branching on
    // validity, so a malformed/rejected turn doesn't also erase the user's
    // side of the conversation from history (a real gap the old
    // fail-everything-together design had: an ungrounded sourceQuote on an
    // unrelated intention used to silently drop the user's message too).
    let episode = episodeStore.appendMessage(prepared.episode, { role: "user", text: turnUserText, at: receivedAtIso });

    if (evaluation.fatal) {
      diagnostics.push(`structured result rejected: ${evaluation.fatalErrors.join("; ")}`);
      // Can't trust anything else in `structuredResult` (not even `reply`) —
      // fixed fallback text only, no statePatch/memory/loops/intentions applied.
      const delivered = await sendReply(FATAL_FALLBACK_REPLY);
      if (delivered) {
        episode = episodeStore.appendMessage(episode, { role: "assistant", text: FATAL_FALLBACK_REPLY, at: new Date().toISOString() });
      }
      episodeStore.save(episode);
      return {
        applied: false,
        reason: "invalid_structured_result",
        errors: evaluation.fatalErrors,
        episodeId: episode.id,
        diagnostics,
      };
    }

    const nowIso = new Date().toISOString();

    // Try creating any schema-valid intentions.create candidate now, before
    // deciding what to actually send — a store-level business rejection (bad
    // dueAt, pending cap full) needs the same "tell the user, don't go quiet
    // or falsely confident" treatment as a schema-level one.
    let intentionsState = intentionsStore.load();
    const intentionFailures = evaluation.intentions.droppedCreate.map((dropped) => (
      { outcome: "invalid_schema", detail: dropped.errors.join("; ") }
    ));
    for (const candidate of evaluation.intentions.create) {
      const result = intentionsStore.create(intentionsState, candidate, { nowIso, sourceTurnId });
      intentionsState = result.state;
      if (result.outcome !== "created" && result.outcome !== "merged") {
        intentionFailures.push({ outcome: result.outcome, detail: result.reason || result.outcome });
      }
    }

    // reply and side-effects are isolated from each other: memory/loop item
    // problems (handled below, near where they're applied) never touch
    // `reply`; an intention-create failure never gets *hidden* inside a
    // reply that might already claim success, but it also never blocks the
    // reply the model actually wrote — the notice is appended, not swapped in.
    let finalReply = evaluation.reply;
    if (intentionFailures.length) {
      diagnostics.push(`intention create failed: ${intentionFailures.map((f) => `${f.outcome}${f.detail ? `(${f.detail})` : ""}`).join(", ")}`);
      const notice = buildIntentionFailureNotice(intentionFailures);
      finalReply = finalReply ? `${finalReply}\n\n${notice}` : notice;
    }

    let delivered = true;
    if (finalReply) {
      delivered = await sendReply(finalReply);
    }
    if (!delivered) {
      // Spec §8: everything past this point voids — never let state claim an
      // assistant reply the user never actually saw. The user's own message
      // (appended above) stays recorded regardless; that fact isn't in
      // question just because *our* side failed to send.
      episodeStore.save(episode);
      return { applied: false, reason: "send_failed", episodeId: episode.id, diagnostics };
    }

    let currentState = currentStateStore.load();
    let memoryState = memoryStore.load();

    currentState = currentStateStore.applyPatch(currentState, evaluation.statePatch, {
      lastUserMessageAt: receivedAtIso,
      lastAgentMessageAt: finalReply ? nowIso : undefined,
    });

    for (const loop of evaluation.loops.add) {
      currentState = currentStateStore.addLoop(currentState, loop);
    }
    for (const loopId of evaluation.loops.resolve) {
      currentState = currentStateStore.resolveLoop(currentState, loopId);
    }
    if (evaluation.loops.dropped.length) {
      diagnostics.push(`loops items dropped: ${evaluation.loops.dropped.length}`);
    }

    if (memoryState.memories.length && prepared.usedContextualMemoryIds.length) {
      memoryState = memoryStore.markUsed(memoryState, prepared.usedContextualMemoryIds, { nowIso });
    }
    for (const candidate of evaluation.memory.remember) {
      ({ state: memoryState } = memoryStore.remember(memoryState, candidate, { nowIso }));
    }
    for (const memoryId of evaluation.memory.forget) {
      ({ state: memoryState } = memoryStore.forget(memoryState, memoryId, { nowIso }));
    }
    if (evaluation.memory.dropped.length) {
      diagnostics.push(`memory items dropped: ${evaluation.memory.dropped.length}`);
    }

    const resolveIds = [...evaluation.intentions.resolve, ...prepared.pendingResumeTopicIds];
    if (resolveIds.length) {
      ({ state: intentionsState } = intentionsStore.resolve(intentionsState, resolveIds));
    }

    if (finalReply) {
      episode = episodeStore.appendMessage(episode, { role: "assistant", text: finalReply, at: nowIso });
    }

    let rolloverAction = "none";
    if (prepared.preTurnBudgetStatus !== "none" && evaluation.handoff) {
      episode.handoff = evaluation.handoff;
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
      reply: finalReply,
      episodeId: episode.id,
      rolloverAction,
      diagnostics,
    };
  }

  return { prepareTurn, applyTurn };
}

module.exports = { createTurnCoordinator };
