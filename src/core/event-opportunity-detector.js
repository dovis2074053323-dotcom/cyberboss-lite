// Event Opportunity (task #13): a low-frequency (~5min, config.eventOpportunityIntervalMs)
// poll that decides whether the *current* observation bundle differs enough
// from what was last seen to be worth queuing a proactive turn over — as
// opposed to Stochastic Pulse (task #9-11), which fires on a random interval
// regardless of content. Both end up in the same system-message-queue-store
// (source differs: "event_opportunity" vs "stochastic_pulse"), both never
// call Claude themselves — this module doesn't either, it's pure comparison
// logic with no I/O, same shape as observation-bundle.js being separate from
// system-checkin-poller.js.
//
// Delta signals (vv's spec, this session): new context / long silence / open
// loop change / environment change. Deliberately no Supabase Realtime (vv's
// call, this session) — this is a poll-and-diff, not a subscription.
//
// Dedupe vs cooldown are two separate mechanisms and both matter:
//   - Dedupe (snapshot comparison): a signal only counts as "new" if the
//     relevant field actually changed since the last *observed* snapshot
//     (persisted every tick regardless of whether that tick fired) — so a
//     value that changed once and then holds steady never re-fires. This is
//     what stops "long silence" from firing every single tick forever once
//     the threshold is first crossed: `longSilenceActive` is a derived
//     boolean, not the raw elapsed time, so it only edges true->false->true,
//     never re-fires while the user just stays quiet.
//   - Cooldown (lastFiredAt): a blanket minimum gap between any two firings,
//     independent of which signal caused them — a safety net against
//     multiple distinct real deltas landing close together, not the primary
//     anti-spam mechanism (dedupe is).

function buildSnapshot(bundle, { now, longSilenceMs }) {
  const segments = Array.isArray(bundle?.companionSegments) ? bundle.companionSegments : [];
  const latestSegmentStartTs = segments[0]?.start_ts || null;

  const openLoopsKey = JSON.stringify(Array.isArray(bundle?.openLoops) ? bundle.openLoops : []);

  const activity = bundle?.taskerSnapshot?.activity || null;
  const health = bundle?.taskerSnapshot?.health || null;
  const environmentKey = JSON.stringify({
    currentApp: activity?.current_app ?? null,
    locationStatus: health?.location_status ?? null,
  });

  const lastUserMessageAt = bundle?.currentState?.lastUserMessageAt || null;
  const elapsedSinceUserMs = lastUserMessageAt ? now - new Date(lastUserMessageAt).getTime() : null;
  const longSilenceActive = typeof elapsedSinceUserMs === "number" && Number.isFinite(elapsedSinceUserMs)
    ? elapsedSinceUserMs >= longSilenceMs
    : false;

  return {
    latestSegmentStartTs,
    openLoopsKey,
    environmentKey,
    lastUserMessageAt,
    longSilenceActive,
  };
}

function diffReasons(previousSnapshot, currentSnapshot) {
  const reasons = [];
  if (!previousSnapshot) {
    // First observation ever (fresh state / first boot) — nothing to diff
    // against, so nothing is "new" yet. Just establish the baseline.
    return reasons;
  }
  if (currentSnapshot.latestSegmentStartTs && currentSnapshot.latestSegmentStartTs !== previousSnapshot.latestSegmentStartTs) {
    reasons.push("new_context");
  }
  if (currentSnapshot.openLoopsKey !== previousSnapshot.openLoopsKey) {
    reasons.push("open_loop_change");
  }
  if (currentSnapshot.environmentKey !== previousSnapshot.environmentKey) {
    reasons.push("environment_change");
  }
  if (currentSnapshot.longSilenceActive && !previousSnapshot.longSilenceActive) {
    reasons.push("long_silence");
  }
  return reasons;
}

// bundle: observation-bundle.js's build() output. previous: { snapshot, lastFiredAt }
// as persisted by event-opportunity-state-store.js (either field may be null).
function evaluateOpportunity({ bundle, previous, now = Date.now(), cooldownMs, longSilenceMs }) {
  const currentSnapshot = buildSnapshot(bundle, { now, longSilenceMs });
  const reasons = diffReasons(previous?.snapshot || null, currentSnapshot);

  const cooldownActive = Boolean(previous?.lastFiredAt) && (now - new Date(previous.lastFiredAt).getTime()) < cooldownMs;
  const worth = reasons.length > 0 && !cooldownActive;

  return {
    worth,
    reasons,
    cooldownActive,
    // Always advance the observed snapshot, whether or not this tick fired —
    // this is what makes dedupe work (see module comment).
    nextSnapshot: currentSnapshot,
  };
}

module.exports = { buildSnapshot, diffReasons, evaluateOpportunity };
