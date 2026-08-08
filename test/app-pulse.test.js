// Pulse (session 3, minimal scope): a fixed-interval tick whose only job is to
// call the already-wired runDueIntentionsCheck() — no autonomous "reach out to
// chat" behavior, no Claude call from the tick itself. These tests exercise
// startPulse/runPulseTick/stopPulse directly, stubbing runDueIntentionsCheck
// so they never touch real WeChat/Claude/lock I/O — that's already covered by
// test/host-lock.test.js and test/intentions-store.test.js's fake-lock suite.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApp } = require("./helpers/app-test-config");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("startPulse ticks on config.pulseIntervalMs and calls runDueIntentionsCheck each time", async () => {
  const app = buildApp({ pulseIntervalMs: 30 });
  const calls = [];
  app.runDueIntentionsCheck = async () => {
    calls.push(Date.now());
  };

  const t0 = Date.now();
  app.startPulse();
  await sleep(140);
  app.stopPulse();

  assert.ok(calls.length >= 3, `应该在 140ms 内 tick 至少 3 次（间隔 30ms），实际 ${calls.length} 次`);
  const firstElapsed = calls[0] - t0;
  assert.ok(firstElapsed >= 15 && firstElapsed < 100, `第一次 tick 应该在约一个 interval 之后，实际 ${firstElapsed}ms`);
});

test("tick 本身不调用 Claude——只调用 runDueIntentionsCheck，没有其他副作用路径", async () => {
  const app = buildApp({ pulseIntervalMs: 30 });
  let claudeCalled = false;
  app.runtimeAdapter.sendSingleTurn = async () => {
    claudeCalled = true;
    return { structuredResult: {}, usage: {} };
  };
  app.runDueIntentionsCheck = async () => {}; // no-op, mirrors "nothing due"

  app.startPulse();
  await sleep(100);
  app.stopPulse();

  assert.equal(claudeCalled, false, "Pulse tick 不应该在任何路径上直接或间接调用 Claude");
});

test("重入保护：上一次 tick 还没结束时，下一次 interval 触发应该被跳过，不会并发调用", async () => {
  const app = buildApp({ pulseIntervalMs: 20 });
  let inFlight = 0;
  let maxConcurrent = 0;
  let callCount = 0;
  let release;
  const firstCallStarted = new Promise((resolvePromise) => {
    app.runDueIntentionsCheck = async () => {
      callCount += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      if (callCount === 1) {
        resolvePromise();
        await new Promise((r) => { release = r; });
      }
      inFlight -= 1;
    };
  });

  app.startPulse();
  await firstCallStarted;
  // 第一次调用还没释放——期间应该有好几个 interval 已经到期，但都应该被重入保护跳过。
  await sleep(100);
  assert.equal(callCount, 1, "第一次调用还没结束时，不应该有第二次并发调用发生");
  assert.equal(maxConcurrent, 1, "任意时刻最多只有一次 runDueIntentionsCheck 在跑");

  release();
  await sleep(60);
  app.stopPulse();
  assert.ok(callCount >= 2, "第一次调用释放之后，后续 tick 应该恢复正常触发");
});

test("runDueIntentionsCheck 抛错时，pulse tick 记录错误但不崩溃，重入保护正确复位供下次 tick 使用", async () => {
  const app = buildApp({ pulseIntervalMs: 25 });
  let callCount = 0;
  app.runDueIntentionsCheck = async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("boom");
    }
  };

  app.startPulse();
  await sleep(120);
  app.stopPulse();

  assert.ok(callCount >= 2, "第一次抛错之后，重入保护应该被正确复位，后续 tick 仍然继续触发");
});

test("stopPulse 之后不再有任何 tick", async () => {
  const app = buildApp({ pulseIntervalMs: 20 });
  let calls = 0;
  app.runDueIntentionsCheck = async () => { calls += 1; };

  app.startPulse();
  await sleep(50);
  app.stopPulse();
  const callsAtStop = calls;
  await sleep(100);
  assert.equal(calls, callsAtStop, "stopPulse 之后不应该再有新的 tick 发生");
});

test("runDueIntentionsCheck 本身：没有 allowedSenderId 时立即返回，不尝试锁、不发送", async () => {
  const app = buildApp();
  let lockAttempted = false;
  app.intentionsStore.load = () => { lockAttempted = true; return { intentions: [] }; };

  const result = await app.runDueIntentionsCheck();
  assert.equal(result.skippedReason, "no_allowed_sender");
  assert.equal(lockAttempted, false, "还没有 allowedSenderId 时不应该走到 intentionsStore.load()");
});
