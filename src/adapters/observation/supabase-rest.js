// Minimal Supabase REST (PostgREST) client — deliberately not the official
// supabase-js SDK, matching this repo's minimal-dependency convention
// (result-schema.js: "no general JSON-Schema engine... matches this repo's
// deliberately minimal dependency set"). Mirrors the same shape keke-overflow's
// own SupabaseClient.kt uses: a thin fetch wrapper, nothing else.
//
// Read-only by design at the call-site level: this module exposes select/patch
// as separate methods so a caller that only needs `select` never accidentally
// gets write access wired in. Cyberboss's own architecture note (this session):
// this MCP-shaped adapter is NOT wired into the Claude runtime as a tool — it's
// plain application code the turn-coordinator's surrounding app logic calls,
// same trust boundary as any other stateStore.

function createSupabaseRestClient({ baseUrl, anonKey }) {
  if (!baseUrl || !anonKey) {
    throw new Error("supabase-rest: baseUrl and anonKey are required");
  }
  const base = baseUrl.replace(/\/+$/, "");

  async function request(method, table, { query = "", body } = {}) {
    const url = `${base}/rest/v1/${table}${query ? `?${query}` : ""}`;
    const headers = {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers.Prefer = "return=minimal";
    }
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`supabase-rest ${method} ${table} -> HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }
    if (response.status === 204 || method === "PATCH") {
      return null;
    }
    return response.json();
  }

  return {
    // query is a raw PostgREST query string, e.g. "select=*&order=ts.desc&limit=10"
    select: (table, query) => request("GET", table, { query }),
    patch: (table, query, body) => request("PATCH", table, { query, body }),
  };
}

module.exports = { createSupabaseRestClient };
