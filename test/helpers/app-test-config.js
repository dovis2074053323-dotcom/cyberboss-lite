// Shared CyberbossApp construction helper for tests that exercise app.js's
// in-process logic (timers, gating) directly, without any real WeChat/Claude
// I/O. Used by test/app-bubble-merge.test.js and test/app-pulse.test.js.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../../src/core/app");

function tempConfig(overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-app-test-"));
  return {
    mode: "start",
    argv: [],
    stateDir,
    workspaceId: "default",
    workspaceRoot: stateDir,
    agentName: "Cyberboss",
    allowedSenderId: "",
    senderAllowlistFile: path.join(stateDir, "sender-allowlist.json"),
    weixinBaseUrl: "https://example.invalid",
    weixinQrBotType: "3",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: undefined,
    accountId: "",
    accountsDir: path.join(stateDir, "accounts"),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    claudeTurnTimeoutMs: 180_000,
    claudeCommand: "claude",
    claudeModel: "",
    systemPromptFile: path.join(stateDir, "system-prompt.txt"),
    claudeConfigDirRoot: path.join(stateDir, "claude-cfg"),
    sharedCredentialsFile: path.join(stateDir, "fake-credentials.json"),
    currentStateFile: path.join(stateDir, "current-state.json"),
    memoriesFile: path.join(stateDir, "memories.json"),
    intentionsFile: path.join(stateDir, "intentions.json"),
    episodesDir: path.join(stateDir, "episodes"),
    episodeCurrentFile: path.join(stateDir, "episodes", "current.json"),
    episodeArchiveDir: path.join(stateDir, "episodes", "archive"),
    enableScheduledIntentions: false,
    hostLockDir: path.join(stateDir, "agent-runtime"),
    hostLockWaitMs: 1_000,
    // Fast timings for tests — production defaults are 1800/3500/60000.
    inboundIdleDelayMs: 60,
    inboundMaxWaitMs: 150,
    pulseIntervalMs: 40,
    ...overrides,
  };
}

function makePrepared(senderId, text) {
  return { senderId, text, receivedAt: new Date().toISOString(), contextToken: "tok", messageId: `msg_${Math.random()}` };
}

function buildApp(overrides) {
  const app = new CyberbossApp(tempConfig(overrides));
  // Neutralize the network side effect bufferInboundMessage fires on every
  // call — sendTyping isn't what these tests are about, and there's no real
  // WeChat account behind this config.
  app.channelAdapter.sendTyping = async () => {};
  return app;
}

module.exports = { tempConfig, makePrepared, buildApp };
