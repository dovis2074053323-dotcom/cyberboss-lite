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

  // Task #12's need_context round 2 only — NOT part of the standard
  // observation bundle (that stays on companion_segments per the header
  // comment above; every-tap-volume companion_events would blow the token
  // budget if pulled on every wake-up). This one is deliberately raw and
  // small (default limit 5), fired at most once per proactive turn, only
  // when the model explicitly asked for fresher context than the aggregated
  // segments gave it — same package/activity/title/sanitized-url fields
  // KekeAccessibilityService writes (commit b0f7483), just unsmoothed by the
  // aggregator's cooldown/dedupe and read on demand instead of on an hourly
  // cron. Never reads or requests image data — there is none to read.
  async function getLatestScreenContext({ limit = 5 } = {}) {
    const parts = [
      "select=detail,created_at",
      "event=eq.screen_context",
      "order=created_at.desc",
      `limit=${limit}`,
    ];
    const rows = await client.select("companion_events", parts.join("&"));
    return Array.isArray(rows) ? rows : [];
  }

  return { getRecentSegments, getLatestScreenContext };
}

module.exports = { createCompanionObservationClient };
