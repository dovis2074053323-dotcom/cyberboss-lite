const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createEventOpportunityStateStore } = require("../src/core/event-opportunity-state-store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-eo-state-test-"));
  return { eventOpportunityStateFile: path.join(dir, "event-opportunity-state.json") };
}

test("load returns null snapshot/lastFiredAt when nothing was ever saved", () => {
  const store = createEventOpportunityStateStore(tempConfig());
  assert.deepEqual(store.load(), {
    snapshot: null,
    lastFiredAt: null,
    evidence: [],
    pendingEnvironment: null,
    candidate: null,
  });
});

test("save then load round-trips", () => {
  const store = createEventOpportunityStateStore(tempConfig());
  store.save({
    snapshot: { latestSegmentStartTs: "2026-08-09T00:00:00Z" },
    lastFiredAt: "2026-08-09T00:05:00Z",
    evidence: [{ type: "new_context", observedAt: "2026-08-09T00:05:00Z", score: 2 }],
    pendingEnvironment: { key: "com.example", count: 1 },
    candidate: null,
  });
  assert.deepEqual(store.load(), {
    snapshot: { latestSegmentStartTs: "2026-08-09T00:00:00Z" },
    lastFiredAt: "2026-08-09T00:05:00Z",
    evidence: [{ type: "new_context", observedAt: "2026-08-09T00:05:00Z", score: 2 }],
    pendingEnvironment: { key: "com.example", count: 1 },
    candidate: null,
  });
});
