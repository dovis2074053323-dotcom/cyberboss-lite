const { createSupabaseRestClient } = require("./supabase-rest");

// Reads Tasker's already-structured Snapshot layer directly — health_snapshot /
// activity_snapshot — instead of `agent_dashboard`'s pre-formatted text
// summary. Per this session's decision 9: `agent_dashboard` isn't documented
// anywhere in ombre-app's architecture doc (only health_snapshot/
// activity_snapshot are), and the old keke-sentinel.py had to regex-parse
// agent_dashboard's text back into numbers — a pointless round trip when the
// structured tables are one query away and are already each project's
// documented single source of truth (docs/agent-data-architecture.md §三:
// "Snapshot 是唯一事实来源"). Verified live this session with the existing
// Tasker anon key: both tables return 200 for anon SELECT despite
// agent-data-architecture.md's permission table claiming anon has no access —
// that doc predates this check and is stale on this one point; real RLS wins.
//
// Both tables are single-row (id=1) per the architecture doc, so no filter or
// pagination is needed — `select=*` always returns 0 or 1 rows.
function createTaskerSnapshotClient(config) {
  const client = createSupabaseRestClient({
    baseUrl: config.taskerSupabaseUrl,
    anonKey: config.taskerSupabaseAnonKey,
  });

  async function getSnapshot() {
    const [healthRows, activityRows] = await Promise.all([
      client.select("health_snapshot", "select=*"),
      client.select("activity_snapshot", "select=*"),
    ]);
    return {
      health: healthRows?.[0] || null,
      activity: activityRows?.[0] || null,
    };
  }

  return { getSnapshot };
}

module.exports = { createTaskerSnapshotClient };
