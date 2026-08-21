const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildArgs,
  buildEnv,
  createClaudeRunner,
  parseResult,
} = require("../src/claude");

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claude-test-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentials = path.join(root, "credentials.json");
  fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } }));
  return {
    stateDir: root,
    runtimeDir: path.join(root, "runtime"),
    claudeConfigDirRoot: path.join(root, "claude-cfg"),
    sharedCredentialsFile: credentials,
    claudeCommand: "claude",
    claudeTurnTimeoutMs: 10_000,
    skipCredentialAcl: true,
  };
}

test("Claude args are one plain-text, no-tool, non-persistent call", () => {
  assert.deepEqual(buildArgs("hello"), [
    "-p",
    "hello",
    "--safe-mode",
    "--tools",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
  ]);
  const args = buildArgs("hello");
  assert.equal(args.includes(["--json", "schema"].join("-")), false);
  assert.equal(args.includes(["--system", "prompt"].join("-")), false);
  assert.equal(args.includes(["--", "resume"].join("")), false);
  assert.equal(args.includes(["--session", "-id"].join("")), false);
  assert.equal(args[args.indexOf("--tools") + 1], "");
});

test("Claude child environment cannot inherit provider switches or API keys", () => {
  const env = buildEnv({
    configDir: "/tmp/turn-config",
    home: "/home/wechatbot",
    sourceEnv: {
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "must-not-pass",
      ANTHROPIC_BASE_URL: "must-not-pass",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      AWS_BEDROCK_RUNTIME_ENDPOINT: "must-not-pass",
    },
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    HOME: "/home/wechatbot",
    CLAUDE_CONFIG_DIR: "/tmp/turn-config",
  });
});

test("parseResult accepts only a successful non-empty text result and preserves usage", () => {
  const result = parseResult(JSON.stringify({
    is_error: false,
    result: "hello",
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
    duration_ms: 321,
  }));
  assert.equal(result.result, "hello");
  assert.deepEqual(result.usage, {
    input_tokens: 11,
    output_tokens: 7,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
    duration_ms: 321,
  });
  assert.throws(() => parseResult('{"is_error":true,"result":"no"}'), /error result/u);
  assert.throws(() => parseResult('{"is_error":false,"result":"  "}'), /empty result/u);
});

test("runner uses its own runtime cwd, temporary config, and one process", async () => {
  const config = tempConfig();
  const calls = [];
  const runner = createClaudeRunner(config, {
    runProcess: async (options) => {
      calls.push(options);
      return JSON.stringify({
        is_error: false,
        result: "reply",
        usage: { input_tokens: 1, output_tokens: 2 },
        duration_ms: 4,
      });
    },
  });

  const result = await runner.run("user text");
  assert.equal(result.result, "reply");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, config.runtimeDir);
  assert.deepEqual(calls[0].args, buildArgs("user text"));
  assert.equal(calls[0].env.HOME, os.homedir());
  assert.equal(fs.existsSync(calls[0].env.CLAUDE_CONFIG_DIR), false);
});
