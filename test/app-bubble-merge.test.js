// Session 3 retune: idle-debounce (resets per message) + hard cap (armed once
// per batch), replacing the old flat 10s inboundMergeWindowMs. These tests
// exercise CyberbossApp's timer logic directly — no real WeChat/Claude I/O —
// by overriding flushPendingBatch to just record when it was invoked, and
// pre-loading pendingMessages/turnGateStore to skip the "already sending
// typing indicator over the network" side effects that bufferInboundMessage
// would otherwise trigger.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");

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
    // Fast timings for the test — production defaults are 1800/3500.
    inboundIdleDelayMs: 60,
    inboundMaxWaitMs: 150,
    ...overrides,
  };
}

function makePrepared(senderId, text) {
  return { senderId, text, receivedAt: new Date().toISOString(), contextToken: "tok", messageId: `msg_${Math.random()}` };
}

function buildApp(overrides) {
  const app = new CyberbossApp(tempConfig(overrides));
  // Neutralize the network side effect bufferInboundMessage fires on every
  // call — sendTyping isn't what this test is about, and there's no real
  // WeChat account behind this config.
  app.channelAdapter.sendTyping = async () => {};
  const flushCalls = [];
  app.flushPendingBatch = async () => {
    flushCalls.push(Date.now());
  };
  return { app, flushCalls };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("单条消息在 idleDelay 后合并触发，不用等满 maxWait（远快于旧的 10s）", async () => {
  const { app, flushCalls } = buildApp();
  const t0 = Date.now();
  app.bufferInboundMessage(makePrepared("u1", "hi"));

  await sleep(250);
  assert.equal(flushCalls.length, 1, "应该恰好触发一次 flush");
  const elapsed = flushCalls[0] - t0;
  assert.ok(elapsed >= 50 && elapsed < 150, `应该在 idleDelay(~60ms) 附近触发，实际 ${elapsed}ms`);
});

test("idle 定时器在每条新消息到达时重置——持续冒泡时不会提前触发", async () => {
  const { app, flushCalls } = buildApp();
  const t0 = Date.now();
  app.bufferInboundMessage(makePrepared("u1", "1"));
  await sleep(40);
  app.bufferInboundMessage(makePrepared("u1", "2"));
  await sleep(40);
  app.bufferInboundMessage(makePrepared("u1", "3"));
  // 到这里已经过了 ~80ms，超过 idleDelay(60ms) 但因为每次都重置，还不该触发。
  assert.equal(flushCalls.length, 0, "idle 计时器应该被每条新消息重置，此时还不该 flush");

  await sleep(200);
  assert.equal(flushCalls.length, 1, "停止发消息后应该恰好 flush 一次");
  const elapsed = flushCalls[0] - t0;
  assert.ok(elapsed < app.config.inboundMaxWaitMs + 100, `不该被拖到超过 maxWait 太多，实际 ${elapsed}ms`);
});

test("maxWait 是硬上限：持续每 40ms 发一条消息（小于 idleDelay 60ms）也会在 maxWait 附近被强制 flush", async () => {
  const { app, flushCalls } = buildApp();
  const t0 = Date.now();
  app.bufferInboundMessage(makePrepared("u1", "1"));
  const interval = setInterval(() => {
    app.bufferInboundMessage(makePrepared("u1", "n"));
  }, 40);

  await sleep(400);
  clearInterval(interval);

  assert.equal(flushCalls.length, 1, "maxWait 到期应该强制 flush 恰好一次，即使消息还在持续到达");
  const elapsed = flushCalls[0] - t0;
  assert.ok(
    elapsed >= app.config.inboundMaxWaitMs - 30 && elapsed < app.config.inboundMaxWaitMs + 100,
    `应该在 maxWait(~150ms) 附近被强制触发，实际 ${elapsed}ms`,
  );
});

test("下一批消息会重新设置 maxWait——不是全进程只生效一次", async () => {
  const { app, flushCalls } = buildApp();
  app.bufferInboundMessage(makePrepared("u1", "batch1"));
  await sleep(200);
  assert.equal(flushCalls.length, 1);

  const t1 = Date.now();
  app.bufferInboundMessage(makePrepared("u1", "batch2"));
  await sleep(200);
  assert.equal(flushCalls.length, 2, "第二批应该独立触发一次新的 flush");
  const elapsed = flushCalls[1] - t1;
  assert.ok(elapsed >= 40 && elapsed < 150, `第二批也应该在 idleDelay 附近触发，实际 ${elapsed}ms`);
});

test("正在跑的 turn 期间到达的消息不设任何合并计时器——沿用既有 pendingMessages 逻辑，原样不动", async () => {
  const { app, flushCalls } = buildApp();
  app.turnGateStore.begin("cyberboss", app.config.workspaceRoot);
  app.bufferInboundMessage(makePrepared("u1", "during-turn"));

  await sleep(250);
  assert.equal(flushCalls.length, 0, "turn 进行中不应该有任何计时器触发 flush——现有逻辑是轮次结束后立刻递归 flush，不经过合并计时器");
  assert.equal(app.pendingMessages.length, 1, "消息应该原样留在 pendingMessages 里等待轮次结束");
});

test("clearMergeTimers 会同时清掉 idle 和 maxWait，之后不会再有迟到的 flush", async () => {
  const { app, flushCalls } = buildApp();
  app.bufferInboundMessage(makePrepared("u1", "hi"));
  app.clearMergeTimers();
  await sleep(300);
  assert.equal(flushCalls.length, 0, "clearMergeTimers 之后不应该再有任何计时器触发的 flush");
});
