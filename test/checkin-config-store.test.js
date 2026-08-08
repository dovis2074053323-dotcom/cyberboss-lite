const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createCheckinConfigStore } = require("../src/core/checkin-config-store");

function tempConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-config-test-"));
  return {
    checkinConfigFile: path.join(dir, "checkin-config.json"),
    checkinMinIntervalMs: 3 * 60_000,
    checkinMaxIntervalMs: 60 * 60_000,
    ...overrides,
  };
}

test("getRange falls back to config defaults when nothing was ever saved", () => {
  const store = createCheckinConfigStore(tempConfig());
  assert.deepEqual(store.getRange(), { minIntervalMs: 180_000, maxIntervalMs: 3_600_000 });
});

test("setRange then getRange round-trips an override", () => {
  const store = createCheckinConfigStore(tempConfig());
  store.setRange({ minIntervalMs: 60_000, maxIntervalMs: 120_000 });
  assert.deepEqual(store.getRange(), { minIntervalMs: 60_000, maxIntervalMs: 120_000 });
});

test("setRange clamps maxIntervalMs up to minIntervalMs if given inverted", () => {
  const store = createCheckinConfigStore(tempConfig());
  const saved = store.setRange({ minIntervalMs: 100_000, maxIntervalMs: 50_000 });
  assert.equal(saved.maxIntervalMs, 100_000);
});

test("setRange rejects a non-positive or non-numeric range", () => {
  const store = createCheckinConfigStore(tempConfig());
  assert.throws(() => store.setRange({ minIntervalMs: 0, maxIntervalMs: 1000 }));
  assert.throws(() => store.setRange({ minIntervalMs: "nope", maxIntervalMs: 1000 }));
});
