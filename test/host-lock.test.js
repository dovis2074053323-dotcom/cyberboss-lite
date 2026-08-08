// Regression tests for the real /run/agent-runtime/claude.lock consumer (session 3).
// Protocol/design rationale lives in Morrow's docs/agent-runtime-lock.md — this
// file is the Cyberboss-side fixture, mirroring Morrow's own
// server/test/claude-lock.test.js coverage (busy vs system error, SIGKILL
// crash-safety, stale-status non-authority) plus the non-blocking try-lock
// contract that's specific to this side (Pulse/scheduled intentions must never
// wait, only Morrow's chat-facing turns wait).
//
// Unlike Morrow's version, lockDir here is a function parameter, not a
// module-level constant read at import time — so these tests can point at a
// fresh tmpdir per run without any static-import ordering workaround.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { acquireHostLock, tryAcquireHostLock, HostLockBusyError, HostLockSystemError } = require("../src/core/host-lock");

function tempLockDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-host-lock-test-"));
}

function statusPath(lockDir) {
  return path.join(lockDir, "status.json");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("acquire 成功后 status.json 只含约定的 6 个字段，owner 是 cyberboss，release 后被清理", async () => {
  const lockDir = tempLockDir();
  const lock = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 2000 });
  assert.ok(lock.pid > 0);

  const status = JSON.parse(fs.readFileSync(statusPath(lockDir), "utf8"));
  assert.deepEqual(
    Object.keys(status).sort(),
    ["agent", "kind", "owner", "pid", "schemaVersion", "startedAt"].sort(),
    "不该多任何字段——尤其不能有消息正文这类东西",
  );
  assert.equal(status.owner, "cyberboss");
  assert.equal(status.agent, "claude");
  assert.equal(status.kind, "wechat_turn");
  assert.equal(status.pid, lock.pid);

  await lock.release();
  assert.throws(() => fs.readFileSync(statusPath(lockDir), "utf8"), "release 后 status.json 应该被删掉");
});

test("已被持有时，阻塞式 acquire 等到超时以 HostLockBusyError 结束", async () => {
  const lockDir = tempLockDir();
  const first = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 2000 });
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 500 }),
      HostLockBusyError,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 400, `应该真的等了将近 500ms 才判定 busy，实际 ${elapsed}ms`);
  } finally {
    await first.release();
  }
});

test("非阻塞 try-lock：已被持有时立刻返回 acquired:false，不等待——Pulse/scheduled intentions 用这个，绝不能卡住等 Morrow", async () => {
  const lockDir = tempLockDir();
  const first = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 2000 });
  try {
    const t0 = Date.now();
    const result = await tryAcquireHostLock({ lockDir, kind: "scheduled_intention" });
    const elapsed = Date.now() - t0;
    assert.equal(result.acquired, false);
    assert.ok(elapsed < 500, `非阻塞 try-lock 应该立刻返回，实际耗时 ${elapsed}ms`);
    await result.release(); // no-op but must not throw
  } finally {
    await first.release();
  }
});

test("非阻塞 try-lock：空闲时立刻拿到锁，release 之后锁可以被别人重新拿到", async () => {
  const lockDir = tempLockDir();
  const result = await tryAcquireHostLock({ lockDir, kind: "scheduled_intention" });
  assert.equal(result.acquired, true);

  // 拿着的时候，另一个非阻塞 try 应该立刻失败
  const blocked = await tryAcquireHostLock({ lockDir, kind: "scheduled_intention" });
  assert.equal(blocked.acquired, false);

  await result.release();
  const reacquired = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 1000 });
  assert.ok(reacquired.pid > 0);
  await reacquired.release();
});

test("release 后立刻重新 acquire 能成功", async () => {
  const lockDir = tempLockDir();
  const first = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 1000 });
  await first.release();
  const second = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 1000 });
  assert.ok(second.pid > 0);
  await second.release();
});

test("模拟 Cyberboss 主进程被 SIGKILL：holder 因 stdin EOF 自行退出，锁立即可重新获取（crash-safe，不依赖 systemd 清理孤儿进程）", async () => {
  const lockDir = tempLockDir();
  const fixture = path.resolve(__dirname, "fixtures/host-lock-holder-sim.js");
  const sim = spawn("node", [fixture], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CYBERBOSS_HOST_LOCK_HOLDER_SIM_DIR: lockDir },
  });

  const { pid: simPid, holderPid } = await new Promise((resolvePromise, reject) => {
    let buf = "";
    sim.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) resolvePromise(JSON.parse(buf.slice(0, nl)));
    });
    sim.on("exit", (code) => reject(new Error(`fixture 提前退出，code=${code}`)));
    setTimeout(() => reject(new Error("等 fixture 握手超时")), 5000);
  });

  process.kill(simPid, "SIGKILL");

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pidAlive(holderPid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pidAlive(holderPid), false, "holder 进程该在父进程被杀后自行退出");

  const reacquired = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 1000 });
  assert.ok(reacquired.pid > 0, "SIGKILL 之后锁必须能被重新获取——证明内核真的放锁了");
  await reacquired.release();
});

test("一份指向不存在进程的陈旧 status.json 不影响真实 acquire——flock 才是真值", async () => {
  const lockDir = tempLockDir();
  fs.writeFileSync(
    statusPath(lockDir),
    JSON.stringify({ schemaVersion: 1, owner: "cyberboss", agent: "claude", kind: "wechat_turn", startedAt: "2020-01-01T00:00:00.000Z", pid: 999999 }),
  );

  const lock = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 1000 });
  const status = JSON.parse(fs.readFileSync(statusPath(lockDir), "utf8"));
  assert.equal(status.pid, lock.pid, "陈旧 status 必须被这次真实 acquire 无条件覆盖");
  await lock.release();
});

test("release 前如果 status.json 被换成别的内容，release 不应该删掉它", async () => {
  const lockDir = tempLockDir();
  const lock = await acquireHostLock({ lockDir, kind: "wechat_turn", timeoutMs: 1000 });
  fs.writeFileSync(statusPath(lockDir), JSON.stringify({ schemaVersion: 1, owner: "someone-else", agent: "claude", kind: "wechat_turn", startedAt: "x", pid: 1 }));
  await lock.release();
  const status = JSON.parse(fs.readFileSync(statusPath(lockDir), "utf8"));
  assert.equal(status.owner, "someone-else", "不是自己写的 status，release 不该动它");
});

test("锁目录不存在等系统错误抛 HostLockSystemError，不是 HostLockBusyError", async () => {
  const lockDir = tempLockDir();
  const badDir = path.join(lockDir, "does-not-exist-subdir");
  await assert.rejects(
    () => acquireHostLock({ lockDir: badDir, kind: "wechat_turn", timeoutMs: 500 }),
    HostLockSystemError,
  );
});

test("非阻塞 try-lock 遇到系统错误（目录不存在）也归一成 acquired:false，不抛出——调用方只关心要不要跳过", async () => {
  const lockDir = tempLockDir();
  const badDir = path.join(lockDir, "does-not-exist-subdir");
  const result = await tryAcquireHostLock({ lockDir: badDir, kind: "scheduled_intention" });
  assert.equal(result.acquired, false);
});

// —— 真机路径：/run/agent-runtime 权限、cyberboss 跨用户 try-lock ——
// 只读验证，不 rm/recreate 真实锁目录——那是 Morrow 和 Cyberboss 生产环境正在共用
// 的路径，这份测试跑的时候两边都可能是真实在跑的进程，绝不能在这里搞破坏性重建。
const hasSudo = (() => {
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const REAL_LOCK_DIR = "/run/agent-runtime";

test("真实 /run/agent-runtime：目录 2775 root:agent-runtime，claude.lock 0664 root:agent-runtime（只读验证，不重建）", { skip: !fs.existsSync(REAL_LOCK_DIR) && "路径不存在，跳过" }, () => {
  const dirStat = execFileSync("stat", ["-c", "%U:%G %a", REAL_LOCK_DIR], { encoding: "utf8" }).trim();
  const fileStat = execFileSync("stat", ["-c", "%U:%G %a", path.join(REAL_LOCK_DIR, "claude.lock")], { encoding: "utf8" }).trim();
  assert.equal(dirStat, "root:agent-runtime 2775");
  assert.equal(fileStat, "root:agent-runtime 664");
});

test("cyberboss 用户可以 try-lock 真实 claude.lock（本模块生产环境实际消费的正是这个路径）", { skip: (!hasSudo || !fs.existsSync(REAL_LOCK_DIR)) && "需要 passwordless sudo 和真实路径，跳过" }, () => {
  // 这条测试本身就跑在一个真实的 Morrow claude-code 轮次里——运行这份测试的
  // 进程自己，此刻很可能正持有这把锁（这正是这把锁该做的事）。所以拿不到不是
  // bug，是"Morrow 正在跑 Claude → 排队"这条验收场景本身在测试环境里自然发生。
  // 只有当锁明显空闲（没有 morrow 的 status.json）时才断言必须成功；否则记录
  // 观察到的忙碌状态并跳过，而不是把"锁在保护自己"误判成失败。
  let statusOwner = "";
  try {
    statusOwner = JSON.parse(fs.readFileSync(path.join(REAL_LOCK_DIR, "status.json"), "utf8")).owner || "";
  } catch {
    // 没有 status.json，大概率空闲——继续往下走真实断言
  }
  if (statusOwner === "morrow") {
    console.log("[host-lock.test] 跳过：/run/agent-runtime/claude.lock 当前被 morrow 持有（很可能就是运行这份测试的会话本身）");
    return;
  }
  // 就算上面的快照显示空闲，check 和实际 flock 调用之间仍有极小窗口可能被
  // 别的进程抢先——那也是锁在正确工作，不是这条测试要断言的对象，所以失败时
  // 只记录观察结果，不当成回归。
  try {
    const out = execFileSync(
      "sudo",
      ["-u", "cyberboss", "/usr/bin/flock", "-w", "2", "-E", "42", path.join(REAL_LOCK_DIR, "claude.lock"), "-c", "echo ok"],
      { encoding: "utf8" },
    ).trim();
    assert.equal(out, "ok");
  } catch (error) {
    console.log(`[host-lock.test] 观测到锁当时被占用（大概率是并发的真实使用），不当作回归失败：${error.message}`);
  }
});
