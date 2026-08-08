// Decision 5 (Cyberboss Proactive + keke-overflow Companion Rework, this
// session): the proactive turn (Stochastic Pulse / Event Opportunity wake-ups)
// does NOT reuse the full normal-turn contract in result-schema.js. That
// contract lets a turn touch memory/loops/intentions — deliberately withheld
// here. A proactive turn is a system-initiated "is this worth a look" check,
// not a real conversational turn; letting it also write long-term memory or
// open loops would mean a wake-up nobody asked for could quietly reshape
// state the same way a real exchange with the user does. If a proactive turn
// decides something is worth remembering, it has exactly one lever: send a
// message and let the user's own reply (a real turn) carry that through the
// normal contract.
//
// Four actions, no free-form JSON, no template pool:
//   - send_message: `message` is what actually goes to the user, written by
//     the model in this same call, not looked up from a table.
//   - silent: a real decision — evaluated the observation, decided not to
//     reach out this time.
//   - need_vision: text-only signal isn't enough; ask for a screenshot before
//     deciding (session 4's Vision two-turn relay, not built this session —
//     this schema just defines the shape it will consume).
//   - defer: not enough signal to decide either way right now, try again
///    later. Distinct from `silent` (silent = decided against it; defer =
//     didn't decide).

const ACTIONS = ["send_message", "silent", "need_vision", "defer"];

const LIMITS = {
  messageMaxChars: 600,
  reasonMaxChars: 200,
};

const PROACTIVE_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "message"],
  properties: {
    action: { type: "string", enum: ACTIONS },
    message: { type: ["string", "null"], maxLength: LIMITS.messageMaxChars },
    // Internal-only, never sent to the user — why this decision, for logs.
    // Same non-sent-to-user posture as intentions.create[].reason in
    // result-schema.js.
    reason: { type: ["string", "null"], maxLength: LIMITS.reasonMaxChars },
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Single-stage validation (unlike result-schema.js's two-stage design): there
// are no nested per-item arrays here to partially salvage, so any structural
// problem invalidates the whole candidate. The caller's fallback on a fatal
// result must always be `{ action: "silent" }` — never fall back to
// forwarding a possibly-malformed `message`.
function evaluateProactiveResult(candidate) {
  const errors = [];

  if (!isPlainObject(candidate)) {
    return { fatal: true, errors: ["result must be an object"] };
  }

  const allowedKeys = new Set(["action", "message", "reason"]);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unknown top-level field "${key}"`);
    }
  }
  if (!ACTIONS.includes(candidate.action)) {
    errors.push(`action must be one of ${ACTIONS.join(", ")}`);
  }

  const message = candidate.message;
  if (message !== null && message !== undefined && typeof message !== "string") {
    errors.push("message must be a string or null");
  } else if (typeof message === "string" && message.length > LIMITS.messageMaxChars) {
    errors.push(`message exceeds max length ${LIMITS.messageMaxChars}`);
  }

  // send_message without real text is not a usable decision — treat it as
  // fatal (fall back to silent) rather than silently sending an empty bubble.
  if (candidate.action === "send_message" && !(typeof message === "string" && message.trim())) {
    errors.push("action=send_message requires a non-empty message");
  }
  // The other three actions must not carry a message — a model that fills
  // `message` while saying `silent` is a contract violation worth rejecting,
  // not worth guessing about which field the caller meant.
  if (candidate.action !== "send_message" && typeof message === "string" && message.trim()) {
    errors.push(`action=${candidate.action} must not include a message`);
  }

  const reason = candidate.reason;
  if (reason !== null && reason !== undefined && typeof reason !== "string") {
    errors.push("reason must be a string or null");
  } else if (typeof reason === "string" && reason.length > LIMITS.reasonMaxChars) {
    errors.push(`reason exceeds max length ${LIMITS.reasonMaxChars}`);
  }

  if (errors.length) {
    return { fatal: true, errors };
  }

  return {
    fatal: false,
    action: candidate.action,
    message: candidate.action === "send_message" ? message : null,
    reason: typeof reason === "string" ? reason : null,
  };
}

module.exports = {
  PROACTIVE_RESULT_JSON_SCHEMA,
  ACTIONS,
  LIMITS,
  evaluateProactiveResult,
};
