const { createSupabaseRestClient } = require("./supabase-rest");

// Reads keke-overflow's structured companion data — companion_segments is the
// one to prefer (server-aggregated, low-frequency, already deduped/merged by
// ~/scripts/keke-companion-aggregate.py) over raw companion_events (per-tap
// volume, would blow the ~4000 token normal-turn budget and the even tighter
// proactive-turn budget). Segments carry `contexts`/`interaction`/
// `screen_active` as real jsonb (not text) since this session's fix to the
// aggregate script — no JSON.parse needed here, PostgREST already hands back
// native arrays/objects for jsonb columns.
//
// Deliberately no "understanding" here: this module hands back raw rows, the
// same posture as tasker-snapshot.js. Whatever turns this into "is this worth
// waking up for" is the proactive-turn-builder's job (or the model's, inside
// the turn), not this adapter's.
function createCompanionObservationClient(config) {
  const client = createSupabaseRestClient({
    baseUrl: config.companionSupabaseUrl,
    anonKey: config.companionSupabaseAnonKey,
  });

  async function getRecentSegments({ sinceIso, limit = 20 } = {}) {
    const parts = ["select=start_ts,end_ts,summary,contexts,screen_active,interaction", "order=start_ts.desc"];
    if (sinceIso) {
      parts.push(`start_ts=gte.${encodeURIComponent(sinceIso)}`);
    }
    parts.push(`limit=${limit}`);
    const rows = await client.select("companion_segments", parts.join("&"));
    return Array.isArray(rows) ? rows : [];
  }

  // Task #12's need_context round 2 — polls for the device's answer to a real
  // on-demand snapshot request (pet-state.js's requestContextSnapshot(), which
  // triggers KekeAccessibilityService to scan *right now*, bypassing its
  // normal cooldown/debounce — not a re-read of whatever was last passively
  // collected; an earlier version of this adapter did exactly that re-read,
  // corrected this session once the gap was flagged). The device always
  // responds with exactly one `companion_events` row tagged
  // `event=context_snapshot` and `detail.requestId` matching what was sent,
  // whether or not its own privacy filter suppressed the actual content (see
  // AccessibilityPrivacyFilter.kt) — so polling stops as soon as any row with
  // that id shows up, not just when it has real title/url content. Times out
  // (throws) if the device never answers — screen off, WebView backgrounded,
  // app not running, network gap, etc. are all real possibilities. NOT part
  // of the standard bundle (that stays on companion_segments per the header
  // comment above) — this fires at most once per proactive turn, only when
  // the model explicitly asked for it.
  async function getContextSnapshot({ requestId, timeoutMs = 15_000, pollIntervalMs = 1_500 }) {
    if (!requestId) {
      throw new Error("companion-observation: getContextSnapshot requires a requestId");
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parts = [
        "select=detail,created_at",
        "event=eq.context_snapshot",
        `detail->>requestId=eq.${encodeURIComponent(requestId)}`,
        "limit=1",
      ];
      const rows = await client.select("companion_events", parts.join("&"));
      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0];
      }
      if (Date.now() >= deadline) {
        throw new Error(`companion-observation: timed out waiting for context_snapshot response to ${requestId}`);
      }
      await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    }
  }

  return { getRecentSegments, getContextSnapshot };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

module.exports = { createCompanionObservationClient };
