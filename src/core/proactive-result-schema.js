// Proactive turns are intentionally narrower than a normal WeChat turn: they
// cannot mutate memory, loops, intentions, or any other durable relationship
// state. Optional turns choose send_message or silent in one call. Mandatory
// slots receive a separate contract that has no silent branch.

const ACTIONS = ["send_message", "silent"];
const LIMITS = { messageMaxChars: 600, reasonMaxChars: 200 };

const PROACTIVE_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "message", "reason"],
  properties: {
    action: { type: "string", enum: ACTIONS },
    message: { type: ["string", "null"], maxLength: LIMITS.messageMaxChars },
    reason: { type: "string", maxLength: LIMITS.reasonMaxChars },
  },
};

const MANDATORY_PROACTIVE_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "reason"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: LIMITS.messageMaxChars },
    reason: { type: "string", maxLength: LIMITS.reasonMaxChars },
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateReason(candidate, errors) {
  if (typeof candidate.reason !== "string") {
    errors.push("reason must be a string");
  } else if (candidate.reason.length > LIMITS.reasonMaxChars) {
    errors.push(`reason exceeds max length ${LIMITS.reasonMaxChars}`);
  }
}

function evaluateProactiveResult(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) return { fatal: true, errors: ["result must be an object"] };
  for (const key of Object.keys(candidate)) {
    if (!["action", "message", "reason"].includes(key)) errors.push(`unknown top-level field "${key}"`);
  }
  if (!ACTIONS.includes(candidate.action)) errors.push(`action must be one of ${ACTIONS.join(", ")}`);

  const message = candidate.message;
  if (message !== null && typeof message !== "string") {
    errors.push("message must be a string or null");
  } else if (typeof message === "string" && message.length > LIMITS.messageMaxChars) {
    errors.push(`message exceeds max length ${LIMITS.messageMaxChars}`);
  }
  if (candidate.action === "send_message" && !(typeof message === "string" && message.trim())) {
    errors.push("action=send_message requires a non-empty message");
  }
  if (candidate.action === "silent" && typeof message === "string" && message.trim()) {
    errors.push("action=silent must not include a message");
  }
  validateReason(candidate, errors);
  if (errors.length) return { fatal: true, errors };
  return { fatal: false, action: candidate.action, message: candidate.action === "send_message" ? message : null, reason: candidate.reason };
}

function evaluateMandatoryResult(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) return { fatal: true, errors: ["result must be an object"] };
  for (const key of Object.keys(candidate)) {
    if (!["message", "reason"].includes(key)) errors.push(`unknown top-level field "${key}"`);
  }
  if (!(typeof candidate.message === "string" && candidate.message.trim())) {
    errors.push("mandatory message must be non-empty");
  } else if (candidate.message.length > LIMITS.messageMaxChars) {
    errors.push(`message exceeds max length ${LIMITS.messageMaxChars}`);
  }
  validateReason(candidate, errors);
  if (errors.length) return { fatal: true, errors };
  return { fatal: false, message: candidate.message, reason: candidate.reason };
}

module.exports = {
  PROACTIVE_RESULT_JSON_SCHEMA,
  MANDATORY_PROACTIVE_RESULT_JSON_SCHEMA,
  ACTIONS,
  LIMITS,
  evaluateProactiveResult,
  evaluateMandatoryResult,
};
