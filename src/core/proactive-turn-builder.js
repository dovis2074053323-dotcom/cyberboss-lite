// Builds the actual prompt text handed to a proactive turn's runtime call,
// from an observation bundle assembled by observation-bundle.js. Shape
// mirrors upstream WenXiaoWendy/cyberboss's system-message-dispatcher.js
// buildSystemInboundText, adapted to this session's narrow contract
// (proactive-result-schema.js: send_message/silent/need_context/defer)
// instead of upstream's free-form {"action":"silent"|"send_message"} JSON.
//
// Two-round relay (task #12, this session): round 1 gets `refreshedContext`
// undefined and may answer `need_context`; round 2 (proactive-turn-runner.js,
// after fetching a fresher on-demand Accessibility read) passes
// `refreshedContext` and the prompt drops `need_context` from the menu
// entirely — this is a hard cap at two rounds, not a suggestion left to the
// model's judgment, so a model that keeps asking can't turn one wake-up into
// an unbounded chain of Claude calls. `refreshedContext` is raw
// `companion_events` rows (package/activity/title/sanitized-url), never an
// image — task #12 deliberately chose "refresh the existing text signal on
// demand" over building real screenshot transport (see
// proactive-result-schema.js's `need_context` comment for the full rationale).

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

// Raw companion_events rows (event=screen_context), not the hourly-aggregated
// companion_segments — this is what "fresher, fuller" actually means: the
// same package/activity/title/sanitized-url fields KekeAccessibilityService
// already collects (commit b0f7483), just read on demand and unsmoothed by
// the aggregator's cooldown/dedupe, instead of a new capture on the device.
function formatRefreshedContextSection(refreshedContext) {
  if (!refreshedContext || refreshedContext.error) {
    return `Refreshed Accessibility context: (unavailable${refreshedContext?.error ? ` — ${refreshedContext.error}` : ""})`;
  }
  if (!Array.isArray(refreshedContext) || refreshedContext.length === 0) {
    return "Refreshed Accessibility context: (none)";
  }
  const lines = refreshedContext.map((row) => `- ${row.created_at}: ${JSON.stringify(row.detail || {})}`);
  return `Refreshed Accessibility context:\n${lines.join("\n")}`;
}

module.exports = { buildProactiveTurnPrompt };
