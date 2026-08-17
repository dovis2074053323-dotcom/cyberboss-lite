const { createSupabaseRestClient } = require("./supabase-rest");
const { sanitizeCompanionSegments } = require("../../core/privacy-gate");

// Reads keke-overflow's narrative companion data — companion_segments is the
// one to prefer (server-aggregated, low-frequency, already deduped/merged by
// ~/scripts/keke-companion-aggregate.py) over raw companion_events (per-tap
// volume). The proactive boundary receives only time, safe summary, screen
// state and a bounded interaction projection; screen snapshots never cross it.
//
// The adapter does not decide whether to wake. It only projects the already
// sanitized narrative rows into the small observation shape consumed by the
// event detector and proactive prompt builder.
function createCompanionObservationClient(config) {
  const client = createSupabaseRestClient({
    baseUrl: config.companionSupabaseUrl,
    anonKey: config.companionSupabaseAnonKey,
  });

  async function getRecentSegments({ sinceIso, limit = 8 } = {}) {
    const parts = ["select=start_ts,end_ts,summary,screen_active,interaction", "order=start_ts.desc"];
    if (sinceIso) {
      parts.push(`start_ts=gte.${encodeURIComponent(sinceIso)}`);
    }
    parts.push(`limit=${limit}`);
    const rows = await client.select("companion_segments", parts.join("&"));
    return sanitizeCompanionSegments(Array.isArray(rows) ? rows : []).map((row) => {
      const { start_ts, end_ts, summary, screen_active, interaction } = row;
      return { start_ts, end_ts, summary, screen_active, interaction };
    });
  }

  return { getRecentSegments };
}

module.exports = { createCompanionObservationClient };
