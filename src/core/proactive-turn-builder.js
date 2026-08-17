// Render one and only one proactive Claude call. Fresh Clawd context is an
// input supplied by the caller after the host lock and budget reservation;
// the model no longer has a need_context/defer branch that could create a
// second runtime call.
const { sanitizeCompanionSummary, sanitizeCompanionInteraction } = require("./privacy-gate");

function buildProactiveTurnPrompt(bundle, { freshContext, forced = false, candidate = null } = {}) {
  const sections = [
    "SYSTEM ACTION MODE: internal proactive check, not user chat.",
    forced
      ? "This is a mandatory outreach slot. You must send one short natural message."
      : "This is an optional proactive opportunity. Decide whether a short natural message is worth sending now.",
    "",
    "Observation:",
    formatValueSection("Current state", bundle?.currentState),
    formatListSection("Open loops", bundle?.openLoops),
    formatListSection("Core memory", bundle?.coreMemories),
    formatValueSection("Tasker snapshot (health/activity)", bundle?.taskerSnapshot),
    formatSegmentsSection(bundle?.companionSegments),
    formatValueSection("Fresh Clawd Accessibility context", freshContext),
    formatValueSection("Candidate reasons", candidate?.reasons || []),
    formatValueSection("Evidence score", candidate?.evidenceScore ?? 0),
    "",
  ];

  if (forced) {
    sections.push(
      "You must return exactly one JSON object after any consideration. Do not return silent.",
      "Use the available context if something is worth mentioning; otherwise send a natural brief check-in or thought.",
      "Do not mention monitoring, observations, slots, schedules, or internal systems.",
      "Do not invent user behavior or imply that you saw a page the context does not show.",
      "Do not say this is a timed reminder, that a system asked you to contact the user, or create false urgency.",
      "Do not reuse a fixed template merely to satisfy the outreach requirement.",
      '{"message":"<short natural message>","reason":"<why, internal only>"}',
    );
  } else {
    sections.push(
      "Choose exactly one:",
      "  send_message — write the message yourself, natural and short.",
      "  silent — you looked and decided not to reach out this time.",
      "Fresh context may be unavailable; make one decision with the available observation and do not request another round.",
      "Return exactly one JSON object after any consideration. No markdown fences, no text outside it:",
      '{"action":"send_message","message":"<short natural message>","reason":"<why, internal only>"}',
      '{"action":"silent","message":null,"reason":"<why, internal only>"}',
    );
  }

  return sections.join("\n");
}

function formatValueSection(title, value) {
  if (value === undefined || value === null) return `${title}: (none)`;
  if (typeof value === "object" && value.error) return `${title}: (unavailable — ${value.error})`;
  if (typeof value === "object" && value.detail?.filtered) {
    return `${title}: (device looked, but withheld it — ${value.detail.filterReason || "filtered"})`;
  }
  return `${title}: ${JSON.stringify(value)}`;
}

function formatListSection(title, list) {
  if (!Array.isArray(list) || list.length === 0) return `${title}: (none)`;
  return `${title}:\n${list.map((item) => `- ${item}`).join("\n")}`;
}

function formatSegmentsSection(segments) {
  if (!segments || segments.error) {
    return `Recent companion timeline: (unavailable${segments?.error ? ` — ${segments.error}` : ""})`;
  }
  if (!Array.isArray(segments) || segments.length === 0) return "Recent companion timeline: (none)";
  const lines = segments.slice(0, 8).map((segment) => {
    const start = formatSegmentTime(segment.start_ts);
    const end = formatSegmentTime(segment.end_ts);
    const summary = sanitizeCompanionSummary(segment.summary);
    const interaction = formatInteraction(segment.interaction);
    return `- ${start}–${end} ${summary}${interaction ? ` (${interaction})` : ""}`;
  });
  return `Recent companion timeline:\n${lines.join("\n")}`;
}

function formatSegmentTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value ?? "?");
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatInteraction(value) {
  const safe = sanitizeCompanionInteraction(value);
  return Object.entries(safe)
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}

module.exports = { buildProactiveTurnPrompt };
