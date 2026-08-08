const crypto = require("crypto");

// Ported from upstream WenXiaoWendy/cyberboss's system-checkin-poller.js
// ("Stochastic Pulse" in its README). Upstream enqueues one fixed trigger
// string ("%USER% comes to mind again.") on a random interval and lets a full
// downstream turn decide everything from there. This session's decision D
// keeps that "random wake-up, decide nothing here" shape but replaces the
// fixed string with a real observation bundle (memory/context/Tasker
// snapshot/companion segments/open loops — see observation-bundle.js): this
// file still makes zero Claude calls, exactly like upstream and exactly like
// Lite's existing session-3 Pulse. The decision (send/silent/need_vision/
// defer) happens downstream against proactive-result-schema.js's narrow
// contract — wiring the queue drain into an actual Claude turn is task #14
// (app.js scheduler wiring) and task #12 (Vision relay for need_vision),
// both deferred to next session. This file only schedules and enqueues.
//
// Distinct from Lite's existing session-3 Pulse (app.js startPulse/
// runPulseTick): that one is a fixed 60s tick that only drives already-created
// Future Intentions and never enqueues anything new. This is a separate,
// randomly-paced scheduler with its own queue.

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

function createSystemCheckinPoller({ queueStore, checkinConfigStore, buildObservationBundle, onLog = () => {} }) {
  let timer = null;
  let stopped = true;

  function scheduleNext() {
    if (stopped) {
      return;
    }
    const range = checkinConfigStore.getRange();
    const delayMs = pickRandomDelayMs(range.minIntervalMs, range.maxIntervalMs);
    timer = setTimeout(() => {
      void tick().finally(scheduleNext);
    }, delayMs);
    onLog(`next stochastic checkin in ${Math.round(delayMs / 60000)}m`);
  }

  // Exposed directly (not just reachable via start()'s timer) so tests and a
  // future manual-trigger path can fire one tick without waiting on a random
  // real-time delay — same reasoning as app.js's runPulseTick being callable
  // on its own.
  async function tick() {
    try {
      const state = queueStore.load();
      // Mirrors upstream: never stack a new wake-up on an unconsumed one — if
      // the last one hasn't been drained yet (turn-execution side hasn't
      // caught up, or is deliberately paused), skip this tick rather than
      // queueing a second bundle.
      if (queueStore.hasPending(state)) {
        onLog("stochastic checkin skipped: pending system message still in queue");
        return;
      }
      const bundle = await buildObservationBundle();
      const next = queueStore.enqueue(state, {
        id: crypto.randomUUID(),
        source: "stochastic_pulse",
        createdAt: new Date().toISOString(),
        bundle,
      });
      queueStore.save(next);
      onLog("stochastic checkin queued");
    } catch (error) {
      onLog(`stochastic checkin tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function start() {
    if (!stopped) {
      return;
    }
    stopped = false;
    scheduleNext();
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}

module.exports = { createSystemCheckinPoller, pickRandomDelayMs };
