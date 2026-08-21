const test = require("node:test");
const assert = require("node:assert/strict");

const { readConfig } = require("../src/config");

test("config exposes only the single-turn bot runtime", () => {
  const config = readConfig(["start"], {
    WECHAT_CLAUDE_STATE_DIR: "/srv/wechat-claude-bot/state",
    WECHAT_CLAUDE_RUNTIME_DIR: "/srv/wechat-claude-bot/runtime",
    WECHAT_CLAUDE_CONFIG_DIR_ROOT: "/srv/wechat-claude-bot/state/claude-cfg",
    WECHAT_CLAUDE_ALLOWED_SENDER_ID: "sender-1",
    WECHAT_CLAUDE_ACCOUNT_ID: "main",
    WECHAT_CLAUDE_HOST_LOCK_DIR: "/run/agent-runtime",
    WECHAT_CLAUDE_HOST_LOCK_WAIT_MS: "1234",
  });

  assert.equal(config.mode, "start");
  assert.equal(config.stateDir, "/srv/wechat-claude-bot/state");
  assert.equal(config.runtimeDir, "/srv/wechat-claude-bot/runtime");
  assert.equal(config.allowedSenderId, "sender-1");
  assert.equal(config.accountId, "main");
  assert.equal(config.hostLockWaitMs, 1234);
  assert.equal(["work", "space", "Root"].join("") in config, false);
  assert.equal("systemPromptFile" in config, false);
  assert.equal("contextTokenFile" in config, false);
  assert.equal("memoryFile" in config, false);
});

test("config defaults to bot-owned state and runtime paths", () => {
  const config = readConfig([], {});
  assert.equal(config.mode, "help");
  assert.match(config.stateDir, /\.wechat-claude-bot$/u);
  assert.equal(config.runtimeDir, `${config.stateDir}/runtime`);
  assert.equal(config.claudeConfigDirRoot, `${config.stateDir}/claude-cfg`);
  assert.equal(config.weixinBaseUrl, "https://ilinkai.weixin.qq.com");
});
