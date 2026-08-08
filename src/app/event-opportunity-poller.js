const crypto = require("crypto");
const { evaluateOpportunity } = require("../core/event-opportunity-detector");

// Task #13: fixed low-frequency interval (~5min, config.eventOpportunityIntervalMs
// — unlike Stochastic Pulse's random 3-60min range), diffs the freshly built
// observation bundle against what was last seen (event-opportunity-detector.js)
// and only enqueues when something concrete actually changed. Same queue as
// Stochastic Pulse (system-message-queue-store), same "never call Claude
// here, never stack a second wake-up on an undrained one" posture as
// system-checkin-poller.js — this file is deliberately structured as its
// sibling, not a rewrite of it.
function createEventOpportunityPoller({
  queueStore,
  stateStore,
  buildObservationBundle,
  intervalMs,
  cooldownMs,
  longSilenceMs,
  onLog = () => {},
}) {
  let timer = null;
  let stopped = true;

  async function tick() {
    try {
      const queueState = queueStore.load();
      // Same reasoning as Stochastic Pulse: don't pile a second wake-up on
      // top of one turn-execution hasn't drained yet.
      if (queueStore.hasPending(queueState)) {
        onLog("event opportunity skipped: pending system message still in queue");
        return;
      }

      const bundle = await buildObservationBundle();
      const previous = stateStore.load();
      const now = Date.now();
      const { worth, reasons, nextSnapshot } = evaluateOpportunity({
        bundle,
        previous,
        now,
        cooldownMs,
        longSilenceMs,
      });

      if (!worth) {
        // Still persist the observed snapshot even when not firing — this is
        // what makes dedupe work on the next tick (see detector's comment).
        stateStore.save({ snapshot: nextSnapshot, lastFiredAt: previous.lastFiredAt });
        return;
      }

      const next = queueStore.enqueue(queueState, {
        id: crypto.randomUUID(),
        source: "event_opportunity",
        createdAt: new Date(now).toISOString(),
        bundle,
      });
      queueStore.save(next);
      stateStore.save({ snapshot: nextSnapshot, lastFiredAt: new Date(now).toISOString() });
      onLog(`event opportunity queued: ${reasons.join(",")}`);
    } catch (error) {
      onLog(`event opportunity tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function start() {
    if (!stopped) {
      return;
    }
    stopped = false;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}

module.exports = { createEventOpportunityPoller };
