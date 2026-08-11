const test = require("node:test");
const assert = require("node:assert/strict");

const { createMorrowContextRelay } = require("../src/adapters/observation/morrow-context-relay");

test("Morrow relay sends a unique requestId over the loopback internal endpoint and normalizes the response", async () => {
  const original = global.fetch;
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ requestId: "req-1", package: "com.android.chrome", filtered: false }),
    };
  };
  try {
    const relay = createMorrowContextRelay({ morrowBaseUrl: "http://127.0.0.1:8787/" });
    const result = await relay.requestContext({ requestId: "req-1", timeoutMs: 1000 });
    assert.equal(seen.url, "http://127.0.0.1:8787/api/internal/clawd/context");
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["X-Morrow-Request"], "1");
    assert.equal(seen.init.headers["X-Morrow-Internal"], "1");
    assert.deepEqual(JSON.parse(seen.init.body), { requestId: "req-1" });
    assert.equal(result.detail.package, "com.android.chrome");
    assert.equal(result.detail.filtered, false);
  } finally {
    global.fetch = original;
  }
});

test("Morrow relay preserves an explicit filtered response and turns HTTP failures into errors", async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ requestId: "req-2", filtered: true, filterReason: "sensitive_app" }),
  });
  try {
    const result = await createMorrowContextRelay({ morrowBaseUrl: "http://127.0.0.1:8787" }).requestContext({ requestId: "req-2" });
    assert.deepEqual(result.detail, { requestId: "req-2", filtered: true, filterReason: "sensitive_app" });
  } finally {
    global.fetch = original;
  }

  global.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: "not found" }) });
  try {
    await assert.rejects(
      () => createMorrowContextRelay({ morrowBaseUrl: "http://127.0.0.1:8787" }).requestContext({ requestId: "req-3" }),
      /not found/,
    );
  } finally {
    global.fetch = original;
  }
});
