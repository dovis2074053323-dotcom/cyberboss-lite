const test = require("node:test");
const assert = require("node:assert/strict");

const gate = require("../src/core/privacy-gate");

test("custom blocked package uses exact matching and removes the whole screen context", () => {
  gate.setUserBlockedPackages(["com.example.private"]);
  try {
    const blocked = gate.sanitizeCompanionSegments([
      { start_ts: "t1", end_ts: "t2", contexts: [{ package: "com.example.private", title: "Secret" }] },
      { start_ts: "t2", end_ts: "t3", contexts: [{ package: "com.example.private.extra", title: "Keep" }] },
    ]);
    assert.deepEqual(blocked[0].contexts, []);
    assert.deepEqual(blocked[1].contexts, [{ package: "com.example.private.extra", title: "Keep" }]);
  } finally {
    gate.setUserBlockedPackages([]);
  }
});

test("12306/travel packages and travel URLs are blocked before an agent bundle", () => {
  const result = gate.sanitizeCompanionSegments([
    { start_ts: "t1", end_ts: "t2", contexts: [{ package: "com.MobileTicket", title: "订单" }] },
    { start_ts: "t2", end_ts: "t3", contexts: [{ package: "com.android.chrome", url: "https://kyfw.12306.cn/otn/" }] },
  ]);
  assert.deepEqual(result[0].contexts, []);
  assert.deepEqual(result[1].contexts, []);
});

test("weather keeps weather values but drops location and query fields", () => {
  assert.deepEqual(gate.sanitizeHealthSnapshot({
    temperature: 27,
    condition: "rain",
    city: "Shanghai",
    latitude: 31.2,
    location_status: "home",
    latest_hr: 72,
    battery_level: 83,
  }), {
    temperature: 27,
    condition: "rain",
    battery_level: 83,
  });
});

test("location, travel, health and network identity fields are dropped", () => {
  assert.deepEqual(gate.sanitizeStructuredObject({
    location: "home",
    latitude: 31.2,
    destination: "airport",
    hotel: "secret",
    latest_hr: 72,
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    x_forwarded_for: "192.0.2.1",
    cf_connecting_ip: "2001:db8::1",
    ssid: "home-wifi",
    battery_level: 83,
    screen_active: true,
  }), {
    battery_level: 83,
    screen_active: true,
  });
});

test("ordinary non-sensitive activity and events stay intact", () => {
  assert.deepEqual(gate.sanitizeTaskerSnapshot({
    activity: { current_app: "com.example.notes", app_usage_today: { "com.example.notes": 30 } },
    health: { battery_level: 90, battery_charging: true },
  }), {
    activity: { current_app: "com.example.notes", app_usage_today: { "com.example.notes": 30 } },
    health: { battery_level: 90, battery_charging: true },
  });
});

test("companion summaries and interactions are reduced to safe coarse fields", () => {
  const result = gate.sanitizeCompanionSegments([
    {
      start_ts: "t1",
      end_ts: "t2",
      summary: "title=Secret https://example.test/private query=passport",
      contexts: [{ package: "com.example.notes", title: "Secret" }],
      interaction: { tap: 2, detail: "raw detail", secret: "drop" },
    },
    {
      start_ts: "t2",
      end_ts: "t3",
      summary: "social browsing, 14m, active",
      contexts: [],
      interaction: { tap: 3, combo: 1 },
    },
  ]);
  assert.equal(result[0].summary, "activity summary unavailable");
  assert.deepEqual(result[0].interaction, { tap: 2 });
  assert.equal(result[1].summary, "social browsing, 14m, active");
  assert.deepEqual(result[1].interaction, { tap: 3, combo: 1 });
  assert.doesNotMatch(result[0].summary, /Secret|https|passport|title|query/);
});

test("filtered fresh context has no package/activity/title/url shape", () => {
  assert.deepEqual(gate.sanitizeClawdContext({
    filtered: true,
    filterReason: "user_blocked_app",
    package: "com.MobileTicket",
    activity: "SecretActivity",
    title: "订单",
    url: "https://example.test/secret",
  }), { filtered: true, filterReason: "user_blocked_app" });
});

test("unfiltered context still fails closed on sensitive metadata", () => {
  assert.deepEqual(gate.sanitizeClawdContext({
    filtered: false,
    package: "com.example.notes",
    activity: "MainActivity",
    title: "Current location: 31.2, 121.5",
    url: "https://example.test/notes",
  }), { filtered: true, filterReason: "sensitive_context" });
});
