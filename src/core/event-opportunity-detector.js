const EVIDENCE_TTL_MS = 30 * 60 * 1000;
const EVIDENCE_WEIGHTS = Object.freeze({
  open_loop_change: 3,
  new_context: 2,
  long_silence: 2,
  environment_change: 1,
});
const CANDIDATE_THRESHOLD = 3;

function buildSnapshot(bundle, { now, longSilenceMs }) {
  const segments = Array.isArray(bundle?.companionSegments) ? bundle.companionSegments : [];
  const latestSegmentStartTs = segments[0]?.start_ts || null;
  const activity = bundle?.taskerSnapshot?.activity || null;
  const health = bundle?.taskerSnapshot?.health || null;
  const lastUserMessageAt = bundle?.currentState?.lastUserMessageAt || null;
  const elapsedSinceUserMs = lastUserMessageAt ? now - new Date(lastUserMessageAt).getTime() : null;
  const longSilenceActive = typeof elapsedSinceUserMs === "number" && Number.isFinite(elapsedSinceUserMs)
    ? elapsedSinceUserMs >= longSilenceMs
    : false;

  return {
    latestSegmentStartTs,
    openLoopsKey: JSON.stringify(Array.isArray(bundle?.openLoops) ? bundle.openLoops : []),
    currentApp: activity?.current_app ?? null,
    locationStatus: health?.location_status ?? null,
    lastUserMessageAt,
    longSilenceActive,
  };
}

function oldEnvironmentParts(snapshot) {
  if (snapshot && (Object.prototype.hasOwnProperty.call(snapshot, "currentApp")
      || Object.prototype.hasOwnProperty.call(snapshot, "locationStatus"))) {
    return {
      currentApp: snapshot.currentApp ?? null,
      locationStatus: snapshot.locationStatus ?? null,
    };
  }
  try {
    const parsed = JSON.parse(snapshot?.environmentKey || "{}");
    return {
      currentApp: parsed.currentApp ?? null,
      locationStatus: parsed.locationStatus ?? null,
    };
  } catch {
    return { currentApp: null, locationStatus: null };
  }
}

function diffObservation(previousSnapshot, currentSnapshot, pendingEnvironment) {
  const reasons = [];
  if (!previousSnapshot) {
    return { reasons, nextPendingEnvironment: null };
  }

  if (currentSnapshot.latestSegmentStartTs
      && currentSnapshot.latestSegmentStartTs !== previousSnapshot.latestSegmentStartTs) {
    reasons.push("new_context");
  }
  if (currentSnapshot.openLoopsKey !== previousSnapshot.openLoopsKey) {
    reasons.push("open_loop_change");
  }

  const previousEnvironment = oldEnvironmentParts(previousSnapshot);
  if (currentSnapshot.locationStatus !== previousEnvironment.locationStatus) {
    reasons.push("environment_change");
  }

  let nextPendingEnvironment = null;
  if (currentSnapshot.currentApp !== previousEnvironment.currentApp) {
    if (pendingEnvironment?.key === currentSnapshot.currentApp) {
      const count = Number(pendingEnvironment.count) + 1;
      if (count >= 2) {
        reasons.push("environment_change");
      } else {
        nextPendingEnvironment = { key: currentSnapshot.currentApp, count };
      }
    } else {
      nextPendingEnvironment = { key: currentSnapshot.currentApp, count: 1 };
    }
  } else if (pendingEnvironment?.key === currentSnapshot.currentApp) {
    // The first changed-app sample is already in the previous snapshot. A
    // second identical poll is stable even though the raw snapshot advanced.
    const count = Number(pendingEnvironment.count) + 1;
    if (count >= 2) {
      reasons.push("environment_change");
    } else {
      nextPendingEnvironment = { key: currentSnapshot.currentApp, count };
    }
  }

  if (currentSnapshot.longSilenceActive && !previousSnapshot.longSilenceActive) {
    reasons.push("long_silence");
  }
  return { reasons: [...new Set(reasons)], nextPendingEnvironment };
}

function pruneEvidence(evidence, now, ttlMs) {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter((item) => {
    const timestamp = new Date(item?.observedAt).getTime();
    return item && EVIDENCE_WEIGHTS[item.type] && Number.isFinite(timestamp) && now - timestamp <= ttlMs;
  }).map((item) => ({
    type: item.type,
    observedAt: item.observedAt,
    score: EVIDENCE_WEIGHTS[item.type],
  }));
}

function scoreEvidence(evidence) {
  return evidence.reduce((total, item) => total + (EVIDENCE_WEIGHTS[item.type] || 0), 0);
}

function evaluateEvidence({
  bundle,
  previous,
  now = Date.now(),
  longSilenceMs,
  evidenceTtlMs = EVIDENCE_TTL_MS,
}) {
  const currentSnapshot = buildSnapshot(bundle, { now, longSilenceMs });
  const previousSnapshot = previous?.snapshot || null;
  const { reasons, nextPendingEnvironment } = diffObservation(
    previousSnapshot,
    currentSnapshot,
    previous?.pendingEnvironment || null,
  );
  const evidence = [
    ...pruneEvidence(previous?.evidence, now, evidenceTtlMs),
    ...reasons.map((type) => ({
      type,
      observedAt: new Date(now).toISOString(),
      score: EVIDENCE_WEIGHTS[type],
    })),
  ];
  const evidenceScore = scoreEvidence(evidence);
  let candidate = null;
  if (evidenceScore >= CANDIDATE_THRESHOLD) {
    const priorCandidate = previous?.candidate && typeof previous.candidate === "object"
      ? previous.candidate
      : null;
    candidate = {
      id: priorCandidate?.id || null,
      createdAt: priorCandidate?.createdAt || new Date(now).toISOString(),
      reasons: [...new Set(evidence.map((item) => item.type))],
      evidenceScore,
    };
  }

  return {
    reasons,
    evidence,
    evidenceScore,
    candidate,
    nextSnapshot: currentSnapshot,
    nextPendingEnvironment,
  };
}

// Kept as a small compatibility export for callers/tests that only need the
// raw signal names. Candidate gating uses evaluateEvidence above.
function diffReasons(previousSnapshot, currentSnapshot) {
  return diffObservation(previousSnapshot, currentSnapshot, null).reasons;
}

module.exports = {
  buildSnapshot,
  diffReasons,
  evaluateEvidence,
  EVIDENCE_TTL_MS,
  EVIDENCE_WEIGHTS,
  CANDIDATE_THRESHOLD,
};
