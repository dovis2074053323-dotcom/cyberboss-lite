// Assembles what a proactive turn is allowed to see: current state + open
// loops + core memory (all local, from the same stores a normal turn already
// reads) plus Tasker's snapshot and keke-overflow's recent companion segments
// (both remote, via src/adapters/observation/*). Shared between Stochastic
// Pulse (this session) and Event Opportunity (session 4) — both need the same
// bundle shape, just triggered on a different schedule.
//
// Deliberately no contextual-memory / current-message scoring here (unlike
// context-assembler.js's normal-turn injection): there is no "this turn's
// message" to score memory relevance against — only core memory (the always-
// inject tier) is included. Remote sources degrade to an `{ error }` marker
// on failure rather than throwing, so one flaky Supabase project doesn't
// block the whole wake-up — proactive-turn-builder.js renders that marker as
// "(unavailable)" rather than crashing the tick.

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function createObservationBundleBuilder({
  currentStateStore,
  memoryStore,
  taskerSnapshotClient,
  companionObservationClient,
}) {
  async function build() {
    const state = currentStateStore.load();
    const openLoops = currentStateStore.openLoops(state);

    const memState = memoryStore.load();
    const { core } = memoryStore.selectForInjection(memState, {
      openLoopSummaries: openLoops.map((loop) => loop.summary),
    });

    const [taskerSnapshot, companionSegments] = await Promise.all([
      taskerSnapshotClient.getSnapshot().catch((error) => ({ error: formatError(error) })),
      companionObservationClient.getRecentSegments({ limit: 10 }).catch((error) => ({ error: formatError(error) })),
    ]);

    return {
      builtAt: new Date().toISOString(),
      currentState: {
        currentActivity: state.currentActivity,
        recentMood: state.recentMood,
        lastUserMessageAt: state.lastUserMessageAt,
        lastAgentMessageAt: state.lastAgentMessageAt,
      },
      openLoops: openLoops.map((loop) => loop.summary),
      coreMemories: core.map((memory) => memory.fact),
      taskerSnapshot,
      companionSegments,
    };
  }

  return { build };
}

module.exports = { createObservationBundleBuilder };
