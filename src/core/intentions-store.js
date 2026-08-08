const crypto = require("crypto");
const { readJsonStore, writeJsonStoreAtomic } = require("./json-store");

// Spec §6: Future Intentions. Storage/validation/recovery/due-selection/
// execution-interface only this session — real proactive sending stays behind
// config.enableScheduledIntentions (default false) until session 3 wires the
// host-wide try-lock. resume_topic never sends proactively at all; it is only
// injected into the next real inbound turn.
const PENDING_CAP = 10;
const CHECK_IN_MAX_HORIZON_MS = 48 * 60 * 60 * 1000;
const RESUME_TOPIC_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const REMINDER_DEFAULT_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;

// Whether a type's pending intentions get silently cancelled once the user
// reappears on their own (spec §6 general limits: "用户重新出现...时自动取消").
// A reminder is a concrete scheduled task tied to a real dueAt, not a proxy for
// "user has been absent" — the user texting about something else shouldn't
// cancel a medicine reminder due in 20 minutes. check_in and resume_topic both
// exist *because* the user was quiet; once they're not quiet, the premise is
// gone. This is a spec-gap-filling call, documented in the status doc.
function defaultCancelOnInbound(type) {
  return type !== "reminder";
}

function defaultStoreState() {
  return { intentions: [] };
}

function normalizeReason(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function createIntentionsStore(config) {
  const filePath = config.intentionsFile;

  function load() {
    const raw = readJsonStore(filePath, defaultStoreState);
    const { schemaVersion, updatedAt, ...rest } = raw;
    return { intentions: Array.isArray(rest.intentions) ? rest.intentions : [] };
  }

  function save(state) {
    return writeJsonStoreAtomic(filePath, state);
  }

  function pending(state) {
    return state.intentions.filter((intention) => intention.status === "pending");
  }

  function findSimilarPending(state, candidate) {
    const normalizedReason = normalizeReason(candidate.reason);
    return pending(state).find((intention) => (
      intention.type === candidate.type && normalizeReason(intention.reason) === normalizedReason
    ));
  }

  // Per-type validation the model's structured output alone can't guarantee
  // (result-schema.js only checks shape/presence of fields, not business
  // rules like "dueAt must actually parse" or "check_in must be <=48h out").
  function validateCandidate(candidate, { nowMs }) {
    if (candidate.type === "reminder") {
      const dueMs = Date.parse(candidate.dueAt || "");
      if (!Number.isFinite(dueMs)) {
        return { valid: false, reason: "reminder requires a parseable dueAt" };
      }
      if (dueMs <= nowMs) {
        return { valid: false, reason: "reminder dueAt must be in the future" };
      }
      return { valid: true };
    }
    if (candidate.type === "check_in") {
      const dueMs = Date.parse(candidate.dueAt || "");
      if (!Number.isFinite(dueMs)) {
        return { valid: false, reason: "check_in requires a parseable dueAt" };
      }
      if (dueMs <= nowMs || (dueMs - nowMs) > CHECK_IN_MAX_HORIZON_MS) {
        return { valid: false, reason: "check_in dueAt must be within the next 48h" };
      }
      return { valid: true };
    }
    if (candidate.type === "resume_topic") {
      return { valid: true };
    }
    return { valid: false, reason: `unknown intention type ${candidate.type}` };
  }

  function resolveExpiresAt(candidate, { nowMs }) {
    if (candidate.expiresAt) {
      const parsed = Date.parse(candidate.expiresAt);
      if (Number.isFinite(parsed)) {
        return candidate.expiresAt;
      }
    }
    if (candidate.type === "resume_topic") {
      return new Date(nowMs + RESUME_TOPIC_DEFAULT_EXPIRY_MS).toISOString();
    }
    if (candidate.type === "check_in") {
      return candidate.dueAt;
    }
    // reminder: give it a day of grace past dueAt before it's swept as stale,
    // since nothing sends it yet (ENABLE_SCHEDULED_INTENTIONS=false) and it
    // would otherwise sit pending forever, silently eating into the cap of 10.
    const dueMs = Date.parse(candidate.dueAt);
    return new Date(dueMs + REMINDER_DEFAULT_EXPIRY_GRACE_MS).toISOString();
  }

  function create(state, candidate, { nowIso, sourceTurnId }) {
    const nowMs = Date.parse(nowIso);

    const similar = findSimilarPending(state, candidate);
    if (similar) {
      return { state, outcome: "merged", intention: similar };
    }
    if (pending(state).length >= PENDING_CAP) {
      return { state, outcome: "rejected_pending_cap", intention: null };
    }
    const validation = validateCandidate(candidate, { nowMs });
    if (!validation.valid) {
      return { state, outcome: "rejected_invalid", reason: validation.reason, intention: null };
    }

    const record = {
      id: `int_${crypto.randomUUID()}`,
      type: candidate.type,
      dueAt: candidate.type === "resume_topic" ? null : candidate.dueAt,
      expiresAt: resolveExpiresAt(candidate, { nowMs }),
      reason: candidate.reason,
      context: candidate.context || "",
      // The literal text to deliver when this fires — deliberately separate from
      // `reason` (why the intention exists, never sent to the user) and
      // `sourceQuote` (the verbatim evidence it was actually requested). Bug
      // found live: app.js used to send `reason` itself, so a reminder for
      // "cc很萌" went out as "用户要求五分钟后发送指定文字" instead.
      deliveryText: candidate.deliveryText || "",
      sourceQuote: candidate.sourceQuote,
      sourceTurnId: sourceTurnId || "",
      cancelOnInbound: defaultCancelOnInbound(candidate.type),
      status: "pending",
    };
    return { state: { ...state, intentions: [...state.intentions, record] }, outcome: "created", intention: record };
  }

  // "resolve 只能引用真实 intention ID" is a behavioral rule for the model;
  // referencing an unknown/non-pending id here is a silent no-op, matching
  // memory-store.forget's handling of unknown ids (not a structural schema
  // violation, so it doesn't invalidate the whole turn).
  function resolve(state, ids, { status = "resolved" } = {}) {
    const idSet = new Set(ids);
    const matchedIds = [];
    const nextIntentions = state.intentions.map((intention) => {
      if (idSet.has(intention.id) && intention.status === "pending") {
        matchedIds.push(intention.id);
        return { ...intention, status };
      }
      return intention;
    });
    return { state: { ...state, intentions: nextIntentions }, matchedIds };
  }

  // check_in/resume_topic pending items are cancelled once the user reappears
  // on their own — the premise for reaching out (silence) is gone. Called once
  // per real inbound turn, before this turn's model call.
  function cancelOnReappearance(state, { types = ["check_in"] } = {}) {
    const typeSet = new Set(types);
    const cancelledIds = [];
    const nextIntentions = state.intentions.map((intention) => {
      if (intention.status === "pending" && intention.cancelOnInbound && typeSet.has(intention.type)) {
        cancelledIds.push(intention.id);
        return { ...intention, status: "cancelled" };
      }
      return intention;
    });
    return { state: { ...state, intentions: nextIntentions }, cancelledIds };
  }

  function sweepExpired(state, nowMs) {
    const expiredIds = [];
    const nextIntentions = state.intentions.map((intention) => {
      if (intention.status !== "pending") {
        return intention;
      }
      const expiresMs = Date.parse(intention.expiresAt || "");
      if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
        expiredIds.push(intention.id);
        return { ...intention, status: "expired" };
      }
      return intention;
    });
    return { state: { ...state, intentions: nextIntentions }, expiredIds };
  }

  function selectPendingResumeTopics(state) {
    return pending(state).filter((intention) => intention.type === "resume_topic");
  }

  // Execution interface (spec §6): who is "due" right now. Scheduling itself
  // (a poller, a cron trigger) is explicitly out of scope this session — no
  // caller in app.js invokes this yet.
  function selectDueForExecution(state, nowMs) {
    return pending(state).filter((intention) => (
      (intention.type === "reminder" || intention.type === "check_in")
      && Number.isFinite(Date.parse(intention.dueAt || ""))
      && Date.parse(intention.dueAt) <= nowMs
    ));
  }

  return {
    load,
    save,
    pending,
    create,
    resolve,
    cancelOnReappearance,
    sweepExpired,
    selectPendingResumeTopics,
    selectDueForExecution,
  };
}

// Execution wrapper demonstrating the fake-clock/fake-lock contract spec §6
// requires for this session (real sending stays off via config). `sendFn` must
// be a plain delivery call, never a Claude turn — spec §6: "定时执行不得递归
//创建新 intention、memory 或 handoff".
async function executeDueIntentions({ store, state, nowMs, enabled, tryLock, sendFn }) {
  if (!enabled) {
    return { state, executed: [], skippedReason: "disabled" };
  }
  const due = store.selectDueForExecution(state, nowMs);
  const executed = [];
  let nextState = state;
  for (const intention of due) {
    const lock = await tryLock();
    if (!lock.acquired) {
      executed.push({ id: intention.id, sent: false, reason: "lock_busy" });
      continue;
    }
    try {
      await sendFn(intention);
      executed.push({ id: intention.id, sent: true });
      nextState = store.resolve(nextState, [intention.id], { status: "resolved" }).state;
    } catch (error) {
      // A failing send (found live in session 3: a stale/expired WeChat
      // context_token) must not abort the rest of this tick's due list — the
      // intention simply stays pending and gets retried next tick, exactly
      // like lock_busy above. Surfacing the error message here means the
      // caller's own log line carries the real reason instead of only a
      // generic outer "pulse tick failed", without ever including message
      // bodies (spec §7).
      executed.push({ id: intention.id, sent: false, reason: "send_failed", error: formatError(error) });
    } finally {
      lock.release();
    }
  }
  return { state: nextState, executed };
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = {
  createIntentionsStore,
  executeDueIntentions,
  defaultCancelOnInbound,
  PENDING_CAP,
  CHECK_IN_MAX_HORIZON_MS,
  RESUME_TOPIC_DEFAULT_EXPIRY_MS,
};
