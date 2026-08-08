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
  intentionDeliveryTextMaxChars: 300,
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
            required: ["type", "reason", "sourceQuote", "deliveryText"],
            properties: {
              type: { type: "string", enum: INTENTION_TYPES },
              dueAt: { type: ["string", "null"] },
              expiresAt: { type: ["string", "null"] },
              reason: {
                type: "string",
                maxLength: LIMITS.intentionReasonMaxChars,
                description: "内部记录：为什么要创建这个提醒/事项。不会直接发给用户，不需要是可读的通知文案。",
              },
              context: { type: ["string", "null"], maxLength: LIMITS.intentionContextMaxChars },
              sourceQuote: {
                type: "string",
                maxLength: LIMITS.intentionSourceQuoteMaxChars,
                description: "本轮用户消息中逐字出现的原文片段，用来证明用户确实提出过这个请求（允许标点/空白轻微差异，但用词必须一致，不能是转述或概括）。",
              },
              deliveryText: {
                type: ["string", "null"],
                maxLength: LIMITS.intentionDeliveryTextMaxChars,
                description: "到点后真正发给用户的文字，与 reason/sourceQuote 无关，不能写成对请求内容的转述或概括。type=reminder 时：如果用户指定了具体要发送的原话，这里必须是那句原话本身；如果用户没指定具体文字，写一句自然的提醒语。type=check_in 时：写主动关心用户的开场白。type=resume_topic 时：留空（该类型从不主动发送）。",
              },
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasContainerShape(container, arrayKeys) {
  return isPlainObject(container) && arrayKeys.every((key) => Array.isArray(container[key]));
}

// Loosens the brittle exact-substring sourceQuote check found live: a model
// reproducing a quote by hand commonly drifts on superficial punctuation/
// whitespace (full-width vs half-width colon, a dropped trailing "。", a line
// break where the bubble-merge join inserted one) even when it copied the
// actual wording correctly — and the old exact-`.includes()` check treated
// that as "not grounded", silently dropping the whole turn's reply (see
// docs/cyberboss-lite-status.md's session-3 real-traffic bug). NFKC folds
// full-width Latin/punctuation forms to their half-width equivalents; the
// character class then strips whitespace and common CJK/ASCII punctuation on
// both sides of the comparison, so only the actual wording — not formatting —
// has to match, contiguously, as a substring. This keeps the "must be real
// evidence from this turn's text" guarantee (an ungrounded/invented quote
// still fails) while not punishing formatting noise.
const QUOTE_NOISE_PATTERN = /[\s,.!?;:'"，。!?;:、“”‘’「」『』《》〈〉（）()[\]【】\-—_~`·…]/g;

function normalizeForQuoteMatch(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(QUOTE_NOISE_PATTERN, "");
}

function isQuoteGroundedIn(turnUserText, sourceQuote) {
  const normalizedQuote = normalizeForQuoteMatch(sourceQuote);
  if (!normalizedQuote) {
    return false;
  }
  return normalizeForQuoteMatch(turnUserText).includes(normalizedQuote);
}

// Generic id-list evaluator for memory.forget / loops.resolve / intentions.resolve:
// drop non-string/empty entries and anything past the per-turn cap instead of
// failing the whole section — an unknown/malformed id is already a silent
// no-op at the store layer (see intentions-store.js's resolve()), so there is
// no user-visible harm in tolerating it here too.
function evaluateIdList(list, { maxItems }) {
  const valid = [];
  const dropped = [];
  list.forEach((id, index) => {
    if (typeof id !== "string" || !id.trim()) {
      dropped.push({ index, errors: ["must be a non-empty id string"] });
      return;
    }
    if (valid.length >= maxItems) {
      dropped.push({ index, errors: [`exceeds per-turn cap of ${maxItems}`] });
      return;
    }
    valid.push(id);
  });
  return { valid, dropped };
}

function evaluateMemoryRememberItem(item, turnUserText) {
  const errors = [];
  if (!isPlainObject(item)) {
    return ["must be an object"];
  }
  if (!MEMORY_CATEGORIES.includes(item.category)) {
    errors.push("category must be one of the fixed categories");
  }
  if (typeof item.fact !== "string" || !item.fact.trim()) {
    errors.push("fact must be a non-empty string");
  } else if (countHanUnits(item.fact) > LIMITS.memoryFactMaxHanzi) {
    errors.push(`fact exceeds ${LIMITS.memoryFactMaxHanzi} characters`);
  }
  if (!MEMORY_TIERS.includes(item.tier)) {
    errors.push("tier must be core or contextual");
  }
  if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) {
    errors.push("sourceQuote must be a non-empty string");
  } else if (!isQuoteGroundedIn(turnUserText, item.sourceQuote)) {
    errors.push("sourceQuote not grounded in this turn's user text");
  }
  if (item.tags !== undefined) {
    if (!Array.isArray(item.tags) || item.tags.length > LIMITS.memoryTagsMaxItems
      || item.tags.some((tag) => typeof tag !== "string" || tag.length > LIMITS.memoryTagMaxChars)) {
      errors.push("tags must be an array of short strings within the cap");
    }
  }
  return errors;
}

// Spec §3 gates state mutation on validity, but per-item content problems
// (bad category, ungrounded sourceQuote, over the per-turn cap) no longer
// invalidate the whole structured result — only that one memory/loop item is
// dropped (see evaluateStructuredResult below for why `reply` must not pay
// for an unrelated field's mistake).
function evaluateMemory(memory, turnUserText) {
  const validRemember = [];
  const droppedRemember = [];
  memory.remember.forEach((item, index) => {
    const errors = evaluateMemoryRememberItem(item, turnUserText);
    if (errors.length) {
      droppedRemember.push({ index, errors });
      return;
    }
    if (validRemember.length >= LIMITS.memoryRememberMaxItems) {
      droppedRemember.push({ index, errors: [`exceeds per-turn cap of ${LIMITS.memoryRememberMaxItems}`] });
      return;
    }
    validRemember.push(item);
  });
  const { valid: forget, dropped: droppedForget } = evaluateIdList(memory.forget, { maxItems: LIMITS.memoryForgetMaxItems });
  return {
    remember: validRemember,
    forget,
    dropped: [...droppedRemember.map((d) => ({ path: `memory.remember[${d.index}]`, errors: d.errors })),
      ...droppedForget.map((d) => ({ path: `memory.forget[${d.index}]`, errors: d.errors }))],
  };
}

function evaluateLoopAddItem(item, turnUserText) {
  const errors = [];
  if (!isPlainObject(item)) {
    return ["must be an object"];
  }
  if (typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > LIMITS.loopSummaryMaxChars) {
    errors.push("summary must be a non-empty string within the cap");
  }
  if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) {
    errors.push("sourceQuote must be a non-empty string");
  } else if (!isQuoteGroundedIn(turnUserText, item.sourceQuote)) {
    errors.push("sourceQuote not grounded in this turn's user text");
  }
  return errors;
}

function evaluateLoops(loops, turnUserText) {
  const validAdd = [];
  const droppedAdd = [];
  loops.add.forEach((item, index) => {
    const errors = evaluateLoopAddItem(item, turnUserText);
    if (errors.length) {
      droppedAdd.push({ index, errors });
      return;
    }
    if (validAdd.length >= LIMITS.loopsAddMaxItems) {
      droppedAdd.push({ index, errors: [`exceeds per-turn cap of ${LIMITS.loopsAddMaxItems}`] });
      return;
    }
    validAdd.push(item);
  });
  const { valid: resolve, dropped: droppedResolve } = evaluateIdList(loops.resolve, { maxItems: LIMITS.loopsResolveMaxItems });
  return {
    add: validAdd,
    resolve,
    dropped: [...droppedAdd.map((d) => ({ path: `loops.add[${d.index}]`, errors: d.errors })),
      ...droppedResolve.map((d) => ({ path: `loops.resolve[${d.index}]`, errors: d.errors }))],
  };
}

function evaluateIntentionCreateItem(item, turnUserText) {
  const errors = [];
  if (!isPlainObject(item)) {
    return ["must be an object"];
  }
  if (!INTENTION_TYPES.includes(item.type)) {
    errors.push("type must be reminder, check_in, or resume_topic");
  }
  if (typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > LIMITS.intentionReasonMaxChars) {
    errors.push("reason must be a non-empty string within the cap");
  }
  if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) {
    errors.push("sourceQuote must be a non-empty string");
  } else if (!isQuoteGroundedIn(turnUserText, item.sourceQuote)) {
    // Spec §6: "reminder 无明确用户请求时拒绝" — grounding every intention
    // (not just reminder) in a quote from this turn's user text is the
    // mechanical proxy for "the user actually asked for this."
    errors.push("sourceQuote not grounded in this turn's user text");
  }
  if (item.deliveryText !== undefined && item.deliveryText !== null && typeof item.deliveryText !== "string") {
    errors.push("deliveryText must be a string or null");
  } else if (typeof item.deliveryText === "string" && item.deliveryText.length > LIMITS.intentionDeliveryTextMaxChars) {
    errors.push(`deliveryText exceeds max length ${LIMITS.intentionDeliveryTextMaxChars}`);
  } else if ((item.type === "reminder" || item.type === "check_in") && !isNonEmptyString(item.deliveryText)) {
    // Bug found live: without this, a well-formed-but-empty deliveryText
    // silently falls back (in app.js's buildIntentionMessageText) to `reason`
    // — an internal justification, not the message the user asked for (a real
    // reminder for "cc很萌" went out as "用户要求五分钟后发送指定文字"). Reject
    // at creation time so the gap surfaces as a caught failure, not a
    // silently wrong send.
    errors.push(`deliveryText is required and non-empty for type=${item.type} (the literal message to deliver)`);
  }
  return errors;
}

// Unlike memory/loops, a dropped intentions.create item is tracked separately
// (`droppedCreate`) rather than folded into the same bucket as resolve-id
// drops: every create candidate is, by construction (the sourceQuote
// requirement above), something the user explicitly asked for — so its
// failure needs a user-visible notice (turn-coordinator.js), not just a log
// line the way an unrelated dropped memory/loop item gets.
function evaluateIntentions(intentions, turnUserText) {
  const validCreate = [];
  const droppedCreate = [];
  intentions.create.forEach((item, index) => {
    const errors = evaluateIntentionCreateItem(item, turnUserText);
    if (errors.length) {
      droppedCreate.push({ index, errors });
      return;
    }
    if (validCreate.length >= LIMITS.intentionsCreateMaxItems) {
      droppedCreate.push({ index, errors: [`exceeds per-turn cap of ${LIMITS.intentionsCreateMaxItems}`] });
      return;
    }
    validCreate.push(item);
  });
  const { valid: resolve, dropped: droppedResolve } = evaluateIdList(intentions.resolve, { maxItems: LIMITS.intentionsResolveMaxItems });
  return { create: validCreate, resolve, droppedCreate, droppedResolve };
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
//
// Two-stage design (rewritten after a live bug: a sourceQuote formatting
// mismatch on an intentions.create item was voiding the *entire* turn,
// including a perfectly fine `reply` — the user saw "typing…" and then
// nothing, repeatedly, for a request unrelated to the actual defect):
//
//  - Stage 1 (fatal gate): only shape-level problems that mean `reply` itself
//    can't be trusted — the candidate isn't an object, a required top-level
//    key is missing/unknown, `reply`/`statePatch`/`handoff` fail their own
//    checks, or a memory/loops/intentions container isn't even shaped like
//    one. Returns `{ fatal: true, fatalErrors }` — the caller must not send
//    anything from `candidate`, only a fixed fallback notice.
//  - Stage 2 (per-item, non-fatal): once the shape is trustworthy, content
//    problems *inside* memory/loops/intentions items (bad enum, ungrounded
//    sourceQuote, over the per-turn cap) no longer fail the whole result —
//    each item is independently valid or dropped. `reply` always ships
//    regardless of what happened in these sections.
function evaluateStructuredResult(candidate, { turnUserText = "" } = {}) {
  if (!isPlainObject(candidate)) {
    return { fatal: true, fatalErrors: ["result must be an object"] };
  }

  const topLevelKeys = new Set(["reply", "statePatch", "memory", "loops", "intentions", "handoff"]);
  const shapeErrors = [];
  for (const key of Object.keys(candidate)) {
    if (!topLevelKeys.has(key)) {
      fail(shapeErrors, "$", `unknown top-level field "${key}"`);
    }
  }
  for (const required of topLevelKeys) {
    if (!(required in candidate)) {
      fail(shapeErrors, "$", `missing required field "${required}"`);
    }
  }
  if (shapeErrors.length) {
    return { fatal: true, fatalErrors: shapeErrors };
  }

  validateStringOrNull(candidate.reply, "reply", LIMITS.replyMaxChars, shapeErrors);
  validateStatePatch(candidate.statePatch, shapeErrors);
  validateHandoff(candidate.handoff, shapeErrors);
  if (!hasContainerShape(candidate.memory, ["remember", "forget"])) {
    fail(shapeErrors, "memory", "must be an object with remember/forget arrays");
  }
  if (!hasContainerShape(candidate.loops, ["add", "resolve"])) {
    fail(shapeErrors, "loops", "must be an object with add/resolve arrays");
  }
  if (!hasContainerShape(candidate.intentions, ["create", "resolve"])) {
    fail(shapeErrors, "intentions", "must be an object with create/resolve arrays");
  }
  if (shapeErrors.length) {
    return { fatal: true, fatalErrors: shapeErrors };
  }

  return {
    fatal: false,
    reply: candidate.reply === undefined ? null : candidate.reply,
    statePatch: candidate.statePatch,
    handoff: candidate.handoff === undefined ? null : candidate.handoff,
    memory: evaluateMemory(candidate.memory, turnUserText),
    loops: evaluateLoops(candidate.loops, turnUserText),
    intentions: evaluateIntentions(candidate.intentions, turnUserText),
  };
}

module.exports = {
  RESULT_JSON_SCHEMA,
  LIMITS,
  MEMORY_CATEGORIES,
  MEMORY_TIERS,
  INTENTION_TYPES,
  evaluateStructuredResult,
  normalizeForQuoteMatch,
};
