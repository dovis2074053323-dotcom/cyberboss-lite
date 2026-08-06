// Spec §3: the one JSON Schema handed to `claude --json-schema` every turn, plus
// a hand-written JS-side validator that re-checks the parsed structured_output
// independently. The CLI's own schema enforcement is not trusted as the sole
// gate — spec §3: "非法结构不应用任何状态变更" applies regardless of what the
// model/CLI claim to have produced. No general JSON-Schema engine (e.g. ajv) is
// pulled in: the result shape is small and fixed, so a dedicated validator is
// easier to audit than wiring a generic library, and matches this repo's
// deliberately minimal dependency set (session-1 status doc).

const MEMORY_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "boundary",
  "recurring_pattern",
  "important_context",
];
const MEMORY_TIERS = ["core", "contextual"];
const INTENTION_TYPES = ["reminder", "check_in", "resume_topic"];

const LIMITS = {
  replyMaxChars: 2000,
  currentActivityMaxChars: 200,
  expectedReturnAtMaxChars: 64,
  recentMoodMaxChars: 100,
  memoryRememberMaxItems: 1,
  memoryForgetMaxItems: 5,
  memoryFactMaxHanzi: 80,
  memoryTagsMaxItems: 6,
  memoryTagMaxChars: 24,
  memorySourceQuoteMaxChars: 400,
  loopsAddMaxItems: 3,
  loopsResolveMaxItems: 10,
  loopSummaryMaxChars: 200,
  loopSourceQuoteMaxChars: 400,
  intentionsCreateMaxItems: 1,
  intentionsResolveMaxItems: 10,
  intentionReasonMaxChars: 200,
  intentionContextMaxChars: 300,
  intentionSourceQuoteMaxChars: 400,
  handoffSummaryMaxHanzi: 600,
  handoffToneMaxHanzi: 120,
  handoffOpenLoopsMaxItems: 8,
  handoffCarryForwardMaxItems: 8,
  handoffListItemMaxChars: 200,
};

// The CLI-facing schema uses generous UTF-16 maxLength proxies (JSON Schema has
// no "count Han characters" primitive). The precise Han-character caps from the
// spec (fact <=80, handoff summary <=600, tone <=120) are enforced exactly by
// validateStructuredResult below, which is the layer that actually gates state
// mutation.
const RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "statePatch", "memory", "loops", "intentions", "handoff"],
  properties: {
    reply: { type: ["string", "null"], maxLength: LIMITS.replyMaxChars },
    statePatch: {
      type: "object",
      additionalProperties: false,
      properties: {
        currentActivity: { type: ["string", "null"], maxLength: LIMITS.currentActivityMaxChars },
        expectedReturnAt: { type: ["string", "null"], maxLength: LIMITS.expectedReturnAtMaxChars },
        recentMood: { type: ["string", "null"], maxLength: LIMITS.recentMoodMaxChars },
        lastUserMessageAt: { type: ["string", "null"] },
        lastAgentMessageAt: { type: ["string", "null"] },
      },
    },
    memory: {
      type: "object",
      additionalProperties: false,
      required: ["remember", "forget"],
      properties: {
        remember: {
          type: "array",
          maxItems: LIMITS.memoryRememberMaxItems,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["category", "fact", "tier", "sourceQuote"],
            properties: {
              category: { type: "string", enum: MEMORY_CATEGORIES },
              fact: { type: "string", maxLength: LIMITS.memoryFactMaxHanzi * 3 },
              tags: {
                type: "array",
                maxItems: LIMITS.memoryTagsMaxItems,
                items: { type: "string", maxLength: LIMITS.memoryTagMaxChars },
              },
              tier: { type: "string", enum: MEMORY_TIERS },
              sourceQuote: { type: "string", maxLength: LIMITS.memorySourceQuoteMaxChars },
            },
          },
        },
        forget: {
          type: "array",
          maxItems: LIMITS.memoryForgetMaxItems,
          items: { type: "string" },
        },
      },
    },
    loops: {
      type: "object",
      additionalProperties: false,
      required: ["add", "resolve"],
      properties: {
        add: {
          type: "array",
          maxItems: LIMITS.loopsAddMaxItems,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["summary", "sourceQuote"],
            properties: {
              summary: { type: "string", maxLength: LIMITS.loopSummaryMaxChars },
              sourceQuote: { type: "string", maxLength: LIMITS.loopSourceQuoteMaxChars },
            },
          },
        },
        resolve: {
          type: "array",
          maxItems: LIMITS.loopsResolveMaxItems,
          items: { type: "string" },
        },
      },
    },
    intentions: {
      type: "object",
      additionalProperties: false,
      required: ["create", "resolve"],
      properties: {
        create: {
          type: "array",
          maxItems: LIMITS.intentionsCreateMaxItems,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "reason", "sourceQuote"],
            properties: {
              type: { type: "string", enum: INTENTION_TYPES },
              dueAt: { type: ["string", "null"] },
              expiresAt: { type: ["string", "null"] },
              reason: { type: "string", maxLength: LIMITS.intentionReasonMaxChars },
              context: { type: ["string", "null"], maxLength: LIMITS.intentionContextMaxChars },
              sourceQuote: { type: "string", maxLength: LIMITS.intentionSourceQuoteMaxChars },
            },
          },
        },
        resolve: {
          type: "array",
          maxItems: LIMITS.intentionsResolveMaxItems,
          items: { type: "string" },
        },
      },
    },
    handoff: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["summary", "tone", "openLoops", "carryForward"],
      properties: {
        summary: { type: "string", maxLength: LIMITS.handoffSummaryMaxHanzi * 3 },
        tone: { type: "string", maxLength: LIMITS.handoffToneMaxHanzi * 3 },
        openLoops: {
          type: "array",
          maxItems: LIMITS.handoffOpenLoopsMaxItems,
          items: { type: "string", maxLength: LIMITS.handoffListItemMaxChars },
        },
        carryForward: {
          type: "array",
          maxItems: LIMITS.handoffCarryForwardMaxItems,
          items: { type: "string", maxLength: LIMITS.handoffListItemMaxChars },
        },
      },
    },
  },
};

function fail(errors, pathLabel, message) {
  errors.push(`${pathLabel}: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function countHanUnits(value) {
  return Array.from(String(value || "")).length;
}

function validateStringOrNull(value, pathLabel, maxLen, errors) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    fail(errors, pathLabel, "must be a string or null");
    return;
  }
  if (maxLen && value.length > maxLen) {
    fail(errors, pathLabel, `exceeds max length ${maxLen}`);
  }
}

function validateStatePatch(statePatch, errors) {
  if (!isPlainObject(statePatch)) {
    fail(errors, "statePatch", "must be an object");
    return;
  }
  const allowedKeys = new Set([
    "currentActivity",
    "expectedReturnAt",
    "recentMood",
    "lastUserMessageAt",
    "lastAgentMessageAt",
  ]);
  for (const key of Object.keys(statePatch)) {
    if (!allowedKeys.has(key)) {
      fail(errors, "statePatch", `unknown field "${key}"`);
    }
  }
  validateStringOrNull(statePatch.currentActivity, "statePatch.currentActivity", LIMITS.currentActivityMaxChars, errors);
  validateStringOrNull(statePatch.expectedReturnAt, "statePatch.expectedReturnAt", LIMITS.expectedReturnAtMaxChars, errors);
  validateStringOrNull(statePatch.recentMood, "statePatch.recentMood", LIMITS.recentMoodMaxChars, errors);
}

function validateMemory(memory, turnUserText, errors) {
  if (!isPlainObject(memory)) {
    fail(errors, "memory", "must be an object");
    return;
  }
  const remember = memory.remember;
  const forget = memory.forget;
  if (!Array.isArray(remember)) {
    fail(errors, "memory.remember", "must be an array");
  } else if (remember.length > LIMITS.memoryRememberMaxItems) {
    fail(errors, "memory.remember", `at most ${LIMITS.memoryRememberMaxItems} item per turn`);
  } else {
    remember.forEach((item, index) => {
      const pathLabel = `memory.remember[${index}]`;
      if (!isPlainObject(item)) {
        fail(errors, pathLabel, "must be an object");
        return;
      }
      if (!MEMORY_CATEGORIES.includes(item.category)) {
        fail(errors, `${pathLabel}.category`, "must be one of the fixed categories");
      }
      if (typeof item.fact !== "string" || !item.fact.trim()) {
        fail(errors, `${pathLabel}.fact`, "must be a non-empty string");
      } else if (countHanUnits(item.fact) > LIMITS.memoryFactMaxHanzi) {
        fail(errors, `${pathLabel}.fact`, `exceeds ${LIMITS.memoryFactMaxHanzi} characters`);
      }
      if (!MEMORY_TIERS.includes(item.tier)) {
        fail(errors, `${pathLabel}.tier`, "must be core or contextual");
      }
      if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) {
        fail(errors, `${pathLabel}.sourceQuote`, "must be a non-empty string");
      } else if (!turnUserText.includes(item.sourceQuote)) {
        fail(errors, `${pathLabel}.sourceQuote`, "must appear verbatim in this turn's user text");
      }
      if (item.tags !== undefined) {
        if (!Array.isArray(item.tags) || item.tags.length > LIMITS.memoryTagsMaxItems
          || item.tags.some((tag) => typeof tag !== "string" || tag.length > LIMITS.memoryTagMaxChars)) {
          fail(errors, `${pathLabel}.tags`, "must be an array of short strings within the cap");
        }
      }
    });
  }
  if (!Array.isArray(forget)) {
    fail(errors, "memory.forget", "must be an array");
  } else if (forget.length > LIMITS.memoryForgetMaxItems || forget.some((id) => typeof id !== "string" || !id.trim())) {
    fail(errors, "memory.forget", "must be non-empty id strings within the cap");
  }
}

function validateLoops(loops, turnUserText, errors) {
  if (!isPlainObject(loops)) {
    fail(errors, "loops", "must be an object");
    return;
  }
  const add = loops.add;
  const resolve = loops.resolve;
  if (!Array.isArray(add) || add.length > LIMITS.loopsAddMaxItems) {
    fail(errors, "loops.add", `must be an array of at most ${LIMITS.loopsAddMaxItems} items`);
  } else {
    add.forEach((item, index) => {
      const pathLabel = `loops.add[${index}]`;
      if (!isPlainObject(item)) {
        fail(errors, pathLabel, "must be an object");
        return;
      }
      if (typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > LIMITS.loopSummaryMaxChars) {
        fail(errors, `${pathLabel}.summary`, "must be a non-empty string within the cap");
      }
      if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) {
        fail(errors, `${pathLabel}.sourceQuote`, "must be a non-empty string");
      } else if (!turnUserText.includes(item.sourceQuote)) {
        fail(errors, `${pathLabel}.sourceQuote`, "must appear verbatim in this turn's user text");
      }
    });
  }
  if (!Array.isArray(resolve) || resolve.length > LIMITS.loopsResolveMaxItems
    || resolve.some((id) => typeof id !== "string" || !id.trim())) {
    fail(errors, "loops.resolve", "must be an array of id strings within the cap");
  }
}

function validateIntentions(intentions, turnUserText, errors) {
  if (!isPlainObject(intentions)) {
    fail(errors, "intentions", "must be an object");
    return;
  }
  const create = intentions.create;
  const resolve = intentions.resolve;
  if (!Array.isArray(create) || create.length > LIMITS.intentionsCreateMaxItems) {
    fail(errors, "intentions.create", `must be an array of at most ${LIMITS.intentionsCreateMaxItems} item`);
  } else {
    create.forEach((item, index) => {
      const pathLabel = `intentions.create[${index}]`;
      if (!isPlainObject(item)) {
        fail(errors, pathLabel, "must be an object");
        return;
      }
      if (!INTENTION_TYPES.includes(item.type)) {
        fail(errors, `${pathLabel}.type`, "must be reminder, check_in, or resume_topic");
      }
      if (typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > LIMITS.intentionReasonMaxChars) {
        fail(errors, `${pathLabel}.reason`, "must be a non-empty string within the cap");
      }
      if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) {
        fail(errors, `${pathLabel}.sourceQuote`, "must be a non-empty string");
      } else if (!turnUserText.includes(item.sourceQuote)) {
        // Spec §6: "reminder 无明确用户请求时拒绝" — grounding every intention
        // (not just reminder) in a verbatim quote from this turn's user text is
        // the mechanical proxy for "the user actually asked for this," the same
        // pattern already used for memory and loops.
        fail(errors, `${pathLabel}.sourceQuote`, "must appear verbatim in this turn's user text");
      }
    });
  }
  if (!Array.isArray(resolve) || resolve.length > LIMITS.intentionsResolveMaxItems
    || resolve.some((id) => typeof id !== "string" || !id.trim())) {
    fail(errors, "intentions.resolve", "must be an array of id strings within the cap");
  }
}

function validateHandoff(handoff, errors) {
  if (handoff === null || handoff === undefined) {
    return;
  }
  if (!isPlainObject(handoff)) {
    fail(errors, "handoff", "must be an object or null");
    return;
  }
  if (typeof handoff.summary !== "string" || !handoff.summary.trim()) {
    fail(errors, "handoff.summary", "must be a non-empty string");
  } else if (countHanUnits(handoff.summary) > LIMITS.handoffSummaryMaxHanzi) {
    fail(errors, "handoff.summary", `exceeds ${LIMITS.handoffSummaryMaxHanzi} characters`);
  }
  if (typeof handoff.tone !== "string" || !handoff.tone.trim()) {
    fail(errors, "handoff.tone", "must be a non-empty string");
  } else if (countHanUnits(handoff.tone) > LIMITS.handoffToneMaxHanzi) {
    fail(errors, "handoff.tone", `exceeds ${LIMITS.handoffToneMaxHanzi} characters`);
  }
  if (!Array.isArray(handoff.openLoops) || handoff.openLoops.length > LIMITS.handoffOpenLoopsMaxItems
    || handoff.openLoops.some((item) => typeof item !== "string" || item.length > LIMITS.handoffListItemMaxChars)) {
    fail(errors, "handoff.openLoops", "must be an array of short strings within the cap");
  }
  if (!Array.isArray(handoff.carryForward) || handoff.carryForward.length > LIMITS.handoffCarryForwardMaxItems
    || handoff.carryForward.some((item) => typeof item !== "string" || item.length > LIMITS.handoffListItemMaxChars)) {
    fail(errors, "handoff.carryForward", "must be an array of short strings within the cap");
  }
}

// `turnUserText` is this turn's merged user text (spec §3 sourceQuote checks
// are always against *this turn's* user text, never prior episode content).
function validateStructuredResult(candidate, { turnUserText = "" } = {}) {
  const errors = [];
  if (!isPlainObject(candidate)) {
    return { valid: false, errors: ["result must be an object"] };
  }

  const topLevelKeys = new Set(["reply", "statePatch", "memory", "loops", "intentions", "handoff"]);
  for (const key of Object.keys(candidate)) {
    if (!topLevelKeys.has(key)) {
      fail(errors, "$", `unknown top-level field "${key}"`);
    }
  }
  for (const required of topLevelKeys) {
    if (!(required in candidate)) {
      fail(errors, "$", `missing required field "${required}"`);
    }
  }

  validateStringOrNull(candidate.reply, "reply", LIMITS.replyMaxChars, errors);
  validateStatePatch(candidate.statePatch, errors);
  validateMemory(candidate.memory, turnUserText, errors);
  validateLoops(candidate.loops, turnUserText, errors);
  validateIntentions(candidate.intentions, turnUserText, errors);
  validateHandoff(candidate.handoff, errors);

  return { valid: errors.length === 0, errors };
}

module.exports = {
  RESULT_JSON_SCHEMA,
  LIMITS,
  MEMORY_CATEGORIES,
  MEMORY_TIERS,
  INTENTION_TYPES,
  validateStructuredResult,
};
