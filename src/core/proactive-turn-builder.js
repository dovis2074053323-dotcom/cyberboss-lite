// Builds the actual prompt text handed to a proactive turn's runtime call,
// from an observation bundle assembled by observation-bundle.js. Shape
// mirrors upstream WenXiaoWendy/cyberboss's system-message-dispatcher.js
// buildSystemInboundText, adapted to this session's narrow contract
// (proactive-result-schema.js: send_message/silent/need_context/defer)
// instead of upstream's free-form {"action":"silent"|"send_message"} JSON.
//
// Two-round relay (task #12): round 1 gets `refreshedContext` undefined and
// may answer `need_context`; round 2 (proactive-turn-runner.js, after a real
// on-demand device round trip — see companion-observation.js's
// getContextSnapshot) passes `refreshedContext` and the prompt drops
// `need_context` from the menu entirely — a hard cap at two rounds, not a
// suggestion left to the model's judgment, so a model that keeps asking
// can't turn one wake-up into an unbounded chain of Claude calls.
// `refreshedContext` is a single `companion_events` row (`{detail,
// created_at}`) the device wrote in direct response to this turn's request —
// `detail` may carry real `package`/`activity`/`title`/sanitized `url`, or
// `filtered: true` + `filterReason` if the device's own privacy rules
// suppressed it (see keke-overflow's AccessibilityPrivacyFilter.kt) — never
// an image (task #12 chose "refresh the existing text signal on demand" over
// building real screenshot transport; see proactive-result-schema.js's
// `need_context` comment for the full rationale).

function buildProactiveTurnPrompt(bundle, { refreshedContext } = {}) {
  const isRound2 = refreshedContext !== undefined;

  const sections = [
    "SYSTEM ACTION MODE: internal proactive check, not user chat.",
    "You are deciding whether this moment is worth reaching out about — not replying to an incoming message.",
    "",
    "Observation:",
    formatValueSection("Current state", bundle?.currentState),
    formatListSection("Open loops", bundle?.openLoops),
    formatListSection("Core memory", bundle?.coreMemories),
    formatValueSection("Tasker snapshot (health/activity)", bundle?.taskerSnapshot),
    formatSegmentsSection(bundle?.companionSegments),
    "",
  ];

  if (isRound2) {
    sections.push(
      "This is round 2: you already asked for fresher context (need_context) on your first look. Here it is:",
      formatRefreshedContextSection(refreshedContext),
      "",
      "Decide now, exactly one of:",
      "  send_message — write the message yourself, natural and short.",
      "  silent — you looked, decided not to reach out this time.",
      "  defer — not enough signal either way yet, check again later.",
      "need_context is not available this round — you already used it once for this wake-up; decide with what you have.",
      "Return exactly one JSON object after any consideration. No markdown fences, no text outside it:",
      '{"action":"send_message","message":"<short natural message>","reason":"<why, internal only>"}',
      '{"action":"silent","message":null,"reason":"<why, internal only>"}',
      '{"action":"defer","message":null,"reason":"<why, internal only>"}',
    );
  } else {
    sections.push(
      "Decide exactly one of:",
      "  send_message — write the message yourself, natural and short.",
      "  silent — you looked, decided not to reach out this time.",
      "  need_context — the observation above isn't enough; ask for a fresher, fuller on-demand read of what's currently on screen (package/activity/title/URL — text only, never an image) before deciding.",
      "  defer — not enough signal either way yet, check again later.",
      "Return exactly one JSON object after any consideration. No markdown fences, no text outside it:",
      '{"action":"send_message","message":"<short natural message>","reason":"<why, internal only>"}',
      '{"action":"silent","message":null,"reason":"<why, internal only>"}',
      '{"action":"need_context","message":null,"reason":"<why, internal only>"}',
      '{"action":"defer","message":null,"reason":"<why, internal only>"}',
    );
  }

  return sections.filter((line) => line !== "").join("\n");
}

function formatValueSection(title, value) {
  if (value === undefined || value === null) {
    return `${title}: (none)`;
  }
  if (typeof value === "object" && value.error) {
    return `${title}: (unavailable — ${value.error})`;
  }
  return `${title}: ${JSON.stringify(value)}`;
}

function formatListSection(title, list) {
  if (!Array.isArray(list) || list.length === 0) {
    return `${title}: (none)`;
  }
  return `${title}:\n${list.map((item) => `- ${item}`).join("\n")}`;
}

function formatSegmentsSection(segments) {
  if (!segments || segments.error) {
    return `Recent companion segments: (unavailable${segments?.error ? ` — ${segments.error}` : ""})`;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return "Recent companion segments: (none)";
  }
  const lines = segments.slice(0, 10).map((seg) => (
    `- ${seg.start_ts}~${seg.end_ts} screen_active=${seg.screen_active} `
    + `contexts=${JSON.stringify(seg.contexts || [])} interaction=${JSON.stringify(seg.interaction || {})}`
  ));
  return `Recent companion segments:\n${lines.join("\n")}`;
}

// A single companion_events row (event=context_snapshot) the device wrote in
// direct, real-time response to this turn's on-demand request — not a
// re-read of whatever was last passively collected. `detail.filtered` means
// the device saw the request and looked, but its own privacy rules withheld
// the content (sensitive app, or a package like WeChat that never yields
// message-body text) — that's a real, informative answer, not a failure, so
// it's rendered distinctly from "(unavailable)" (which means the request
// itself never got a response — device unreachable, timeout, etc.).
function formatRefreshedContextSection(refreshedContext) {
  if (!refreshedContext || refreshedContext.error) {
    return `Refreshed Accessibility context: (unavailable${refreshedContext?.error ? ` — ${refreshedContext.error}` : ""})`;
  }
  const detail = refreshedContext.detail || {};
  if (detail.filtered) {
    return `Refreshed Accessibility context: (device looked, but withheld it — ${detail.filterReason || "filtered"})`;
  }
  return `Refreshed Accessibility context (as of ${refreshedContext.created_at}): ${JSON.stringify(detail)}`;
}

module.exports = { buildProactiveTurnPrompt };
