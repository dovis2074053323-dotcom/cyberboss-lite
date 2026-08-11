const test = require("node:test");
const assert = require("node:assert/strict");

const { createSupabaseRestClient } = require("../src/adapters/observation/supabase-rest");
const { createTaskerSnapshotClient } = require("../src/adapters/observation/tasker-snapshot");
const { createCompanionObservationClient } = require("../src/adapters/observation/companion-observation");

function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("supabase-rest.select sends apikey/Authorization headers and returns parsed JSON", async () => {
  const stub = stubFetch((url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.headers.apikey, "anon-key");
    assert.equal(init.headers.Authorization, "Bearer anon-key");
    assert.match(url, /\/rest\/v1\/some_table\?select=\*$/);
    return jsonResponse([{ id: 1 }]);
  });
  try {
    const client = createSupabaseRestClient({ baseUrl: "https://x.supabase.co", anonKey: "anon-key" });
    const rows = await client.select("some_table", "select=*");
    assert.deepEqual(rows, [{ id: 1 }]);
  } finally {
    stub.restore();
  }
});

test("supabase-rest.patch sends Prefer:return=minimal and a JSON body, returns null", async () => {
  const stub = stubFetch((url, init) => {
    assert.equal(init.method, "PATCH");
    assert.equal(init.headers.Prefer, "return=minimal");
    assert.deepEqual(JSON.parse(init.body), { expression: "happy" });
    return jsonResponse(null, 204);
  });
  try {
    const client = createSupabaseRestClient({ baseUrl: "https://x.supabase.co", anonKey: "k" });
    const result = await client.patch("some_table", "id=eq.1", { expression: "happy" });
    assert.equal(result, null);
  } finally {
    stub.restore();
  }
});

test("supabase-rest throws with status+body on a non-ok response", async () => {
  const stub = stubFetch(() => ({ ok: false, status: 401, text: async () => "no access", json: async () => ({}) }));
  try {
    const client = createSupabaseRestClient({ baseUrl: "https://x.supabase.co", anonKey: "k" });
    await assert.rejects(() => client.select("t", "select=*"), /HTTP 401.*no access/);
  } finally {
    stub.restore();
  }
});

test("tasker-snapshot.getSnapshot fetches both tables and returns first row or null", async () => {
  const stub = stubFetch((url) => {
    if (url.includes("health_snapshot")) return jsonResponse([{ latest_hr: 71 }]);
    if (url.includes("activity_snapshot")) return jsonResponse([]);
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const client = createTaskerSnapshotClient({
      taskerSupabaseUrl: "https://tasker.supabase.co",
      taskerSupabaseAnonKey: "k",
    });
    const snapshot = await client.getSnapshot();
    assert.deepEqual(snapshot, { health: { latest_hr: 71 }, activity: null });
  } finally {
    stub.restore();
  }
});

test("companion-observation.getRecentSegments returns rows with native jsonb (no double-parse needed)", async () => {
  const stub = stubFetch((url) => {
    assert.match(url, /companion_segments/);
    assert.match(url, /start_ts=gte\.2026-08-09T00%3A00%3A00Z/);
    return jsonResponse([
      { start_ts: "t1", end_ts: "t2", summary: "1 context(s), 0 interaction(s)", contexts: [{ package: "com.android.chrome" }], screen_active: true, interaction: {} },
    ]);
  });
  try {
    const client = createCompanionObservationClient({
      companionSupabaseUrl: "https://companion.supabase.co",
      companionSupabaseAnonKey: "k",
    });
    const rows = await client.getRecentSegments({ sinceIso: "2026-08-09T00:00:00Z" });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].contexts, [{ package: "com.android.chrome" }]);
  } finally {
    stub.restore();
  }
});
