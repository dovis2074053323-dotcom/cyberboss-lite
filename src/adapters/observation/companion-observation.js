const { createSupabaseRestClient } = require("./supabase-rest");
const { sanitizeCompanionSegments } = require("../../core/privacy-gate");

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
    const parts = ["select=start_ts,end_ts,contexts,screen_active,interaction", "order=start_ts.desc"];
    if (sinceIso) {
      parts.push(`start_ts=gte.${encodeURIComponent(sinceIso)}`);
    }
    parts.push(`limit=${limit}`);
    const rows = await client.select("companion_segments", parts.join("&"));
    return sanitizeCompanionSegments(Array.isArray(rows) ? rows : []);
  }

  return { getRecentSegments };
}

module.exports = { createCompanionObservationClient };
