const crypto = require("crypto");
const { evaluateEvidence, EVIDENCE_TTL_MS, EVIDENCE_WEIGHTS } = require("../core/event-opportunity-detector");

// A cheap five-minute observer. It never calls Claude, requests Clawd
// context, or sends WeChat. It only advances the existing observation state,
// accumulates weighted evidence for 30 minutes, and queues one fresh
// candidate when the local budget/cooldown/queue gates allow it.
function createEventOpportunityPoller({
  queueStore,
  stateStore,
  buildObservationBundle,
  intervalMs,
  longSilenceMs,
  evidenceTtlMs = EVIDENCE_TTL_MS,
  canQueueOptional = () => ({ allowed: true }),
  isEnabled = () => true,
  onMetric = () => {},
  onLog = () => {},
}) {
  let timer = null;
  let stopped = true;

  async function tick() {
    try {
      if (!isEnabled()) return { queued: false, reason: "disabled" };
      const previous = stateStore.load();
      const bundle = await buildObservationBundle();
      const now = Date.now();
      const evaluated = evaluateEvidence({
        bundle,
        previous,
        now,
        longSilenceMs,
        evidenceTtlMs,
      });
      let candidate = evaluated.candidate;
      const newlyDetected = Boolean(candidate && !previous.candidate);
      if (newlyDetected) {
        candidate = { ...candidate, id: crypto.randomUUID() };
        onMetric("candidatesDetected");
      }

      const observedState = {
        snapshot: evaluated.nextSnapshot,
        lastFiredAt: previous.lastFiredAt || null,
        evidence: evaluated.evidence,
        pendingEnvironment: evaluated.nextPendingEnvironment,
        candidate,
      };

      if (!candidate) {
        stateStore.save(observedState);
        if (evaluated.reasons.length) {
          onLog(`event evidence ${formatReasons(evaluated.reasons)}`);
        }
        return { queued: false, reasons: evaluated.reasons, score: evaluated.evidenceScore };
      }

      const queueState = queueStore.load();
      if (queueStore.hasPending(queueState)) {
        stateStore.save(observedState);
        onLog(`candidate score=${evaluated.evidenceScore} held: proactive queue pending`);
        return { queued: false, reason: "queue_pending", candidate };
      }

      const eligibility = await Promise.resolve(canQueueOptional({ nowMs: now, candidate, state: observedState }));
      if (!eligibility?.allowed) {
        stateStore.save(observedState);
        onMetric("candidatesSuppressed");
        if (eligibility?.reason === "mandatory_budget_reserved") {
          onLog("optional blocked: mandatory budget reserved");
        } else {
          onLog(`optional candidate held: ${eligibility?.reason || "gate"}`);
        }
        return { queued: false, reason: eligibility?.reason || "gate", candidate };
      }
      if (!isEnabled()) return { queued: false, reason: "disabled", candidate };

      const queued = queueStore.enqueue(queueState, {
        id: candidate.id || crypto.randomUUID(),
        source: "event_opportunity",
        createdAt: new Date(now).toISOString(),
        forced: false,
        reasons: candidate.reasons,
        evidenceScore: candidate.evidenceScore,
      });
      queueStore.save(queued);
      onMetric("candidatesQueued");
      stateStore.save({
        ...observedState,
        lastFiredAt: new Date(now).toISOString(),
        evidence: [],
        candidate: null,
      });
      onLog(`candidate score=${candidate.evidenceScore} queued`);
      return { queued: true, candidate };
    } catch (error) {
      onLog(`event opportunity tick failed: ${error instanceof Error ? error.message : String(error)}`);
      return { queued: false, reason: "error" };
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    timer = setInterval(() => { void tick(); }, intervalMs);
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

function formatReasons(reasons) {
  return reasons.map((reason) => `+${EVIDENCE_WEIGHTS[reason] || 0} ${reason}`).join(" ");
}

module.exports = { createEventOpportunityPoller };
