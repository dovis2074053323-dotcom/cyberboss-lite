// Builds the actual prompt text handed to a proactive turn's runtime call,
// from an observation bundle assembled by observation-bundle.js. Shape
// mirrors upstream WenXiaoWendy/cyberboss's system-message-dispatcher.js
// buildSystemInboundText, adapted to this session's narrow contract
// (proactive-result-schema.js: send_message/silent/need_vision/defer)
// instead of upstream's free-form {"action":"silent"|"send_message"} JSON.
//
// Wiring this into an actual runtime-adapter call — and applying whatever
// decision comes back (WeChat send, keke_state push, or session 4's Vision
// relay for need_vision) — is task #14/#12, not this file. This module only
// produces text.

function buildProactiveTurnPrompt(bundle) {
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
    "Decide exactly one of:",
    "  send_message — write the message yourself, natural and short.",
    "  silent — you looked, decided not to reach out this time.",
    "  need_vision — text isn't enough, you want to see the screen first.",
    "  defer — not enough signal either way yet, check again later.",
    "Return exactly one JSON object after any consideration. No markdown fences, no text outside it:",
    '{"action":"send_message","message":"<short natural message>","reason":"<why, internal only>"}',
    '{"action":"silent","message":null,"reason":"<why, internal only>"}',
    '{"action":"need_vision","message":null,"reason":"<why, internal only>"}',
    '{"action":"defer","message":null,"reason":"<why, internal only>"}',
  ];
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

module.exports = { buildProactiveTurnPrompt };
