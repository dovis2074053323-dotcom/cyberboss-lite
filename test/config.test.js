const test = require("node:test");
const assert = require("node:assert/strict");

// Spec §9 test 14: scheduled intentions (real reminder/check_in proactive
// sending) must default to off. Runs readConfig() with the env var unset/set
// in a child process so it doesn't leak into (or get polluted by) this
// process's own env across other test files.
const { execFileSync } = require("child_process");
const path = require("path");

function readConfigEnableScheduledIntentions(envValue) {
  const script = `
    const { readConfig } = require(${JSON.stringify(path.resolve(__dirname, "..", "src", "core", "config.js"))});
    process.stdout.write(String(readConfig().enableScheduledIntentions));
  `;
  const env = { ...process.env };
  if (envValue === undefined) {
    delete env.CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS;
  } else {
    env.CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS = envValue;
  }
  const output = execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  return output.trim();
}

test("enableScheduledIntentions defaults to false when the env var is unset", () => {
  assert.equal(readConfigEnableScheduledIntentions(undefined), "false");
});

test("enableScheduledIntentions is true only when explicitly set", () => {
  assert.equal(readConfigEnableScheduledIntentions("true"), "true");
  assert.equal(readConfigEnableScheduledIntentions("1"), "true");
  assert.equal(readConfigEnableScheduledIntentions("false"), "false");
});
