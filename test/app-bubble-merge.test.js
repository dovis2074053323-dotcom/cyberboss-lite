// Session 3 retune: idle-debounce (resets per message) + hard cap (armed once
// per batch), replacing the old flat 10s inboundMergeWindowMs. These tests
// exercise CyberbossApp's timer logic directly — no real WeChat/Claude I/O —
// by overriding flushPendingBatch to just record when it was invoked, and
// pre-loading pendingMessages/turnGateStore to skip the "already sending
// typing indicator over the network" side effects that bufferInboundMessage
// would otherwise trigger.
const test = require("node:test");
const assert = require("node:assert/strict");

const { makePrepared, buildApp: buildBaseApp } = require("./helpers/app-test-config");

function buildApp(overrides) {
  const app = buildBaseApp(overrides);
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
