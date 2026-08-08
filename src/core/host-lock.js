// Claude 跨项目宿主机锁 —— Cyberboss Lite ↔ Morrow 的 claude-code 住户，两个共享
// 同一份 Claude OAuth/订阅的独立进程之间的互斥。协议全文见 Morrow 仓库的
// docs/agent-runtime-lock.md（该协议明确写死 owner: "cyberboss" 这条实现的形状，
// 这边只是第二个消费者接进来，不是协议的第二次设计——不要改机制或权限假设）。
//
// 机制：`flock -F -w <timeoutSec> -E <conflictCode> <lockfile> /bin/cat`。
// -F 让 flock 不 fork、直接 exec 进 cat —— 持锁的就是这个 cat 进程本身，生命周期
// 完全由我们手里这根 stdin pipe 决定：写一行哨兵、读到原样回显 = 确认真的拿到锁；
// stdin.end() = 主动放锁；如果 Cyberboss 自己被 SIGKILL/OOM，内核会连带关掉这根
// pipe 的写端，cat 收到 EOF 自行退出，锁照样释放——不依赖 systemd 清理孤儿进程。
//
// timeoutMs === 0 时用 `-w 0`（等价于 --nonblock）：立刻返回，不等待——这是
// Pulse/scheduled intentions 的 try-lock 语义（忙就跳过，绝不能抢占 Morrow）。
// timeoutMs > 0 时是真正的内核级阻塞等待（alarm(2)，不是轮询）——这是 WeChat
// 主动消息的语义（可以等，等不到就失败）。
//
// status.json 只是观测层，flock 才是真值——任何地方都不能靠 status.json 的存在
// 与否判断锁有没有被持有，它只用来回答"上一次/这一次是谁在跑、什么时候开始的"。
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { chmod, readFile, rename, rm, writeFile } = require("fs/promises");
const path = require("path");

const FLOCK_BIN = "/usr/bin/flock";
const CAT_BIN = "/bin/cat";
// flock -E 的退出码，专门跟"其他错误"（路径不存在、没权限……）区分开——那些情况
// flock 会用别的退出码退出（比如 1 或 66），不会跟这个值撞。跟 Morrow 那边用同一个
// 常量值没有必要——两边各自 spawn 各自的 flock 子进程，退出码只在各自进程内解释。
const CONFLICT_EXIT_CODE = 42;
const SCHEMA_VERSION = 1;

class HostLockBusyError extends Error {}
class HostLockSystemError extends Error {}

function lockFilePath(lockDir) {
  return path.resolve(lockDir, "claude.lock");
}

function statusFilePath(lockDir) {
  return path.resolve(lockDir, "status.json");
}

// 花括号里全是纯粹的 IPC 细节（spawn/握手/回显），调用方只需要知道
// acquireHostLock()/tryAcquireHostLock()，不需要知道背后是 flock 命令行。
function spawnHolder(lockDir, timeoutMs) {
  const nonBlocking = timeoutMs <= 0;
  const timeoutSec = nonBlocking ? 0 : Math.max(1, Math.ceil(timeoutMs / 1000));
  const sentinel = `sentinel-${randomUUID()}`;
  const args = ["-F", "-w", String(timeoutSec), "-E", String(CONFLICT_EXIT_CODE), lockFilePath(lockDir), CAT_BIN];

  return new Promise((resolvePromise, reject) => {
    // 不经 shell：路径和参数都是固定值/内部生成的 UUID，没有拼接外部输入。
    const child = spawn(FLOCK_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString("utf8");
      if (stdoutBuf.includes(sentinel)) settle(() => resolvePromise(child));
    });
    child.stderr.on("data", (d) => {
      stderrBuf += d.toString("utf8");
    });
    // flock 输掉竞争/报错时会很快退出、关掉 stdin 读端——这时候我们的 write()
    // 可能正好在路上，Socket 会单独发一个 'error' 事件（EPIPE），跟 write() 自己
    // 的回调是两条独立路径，不接住会直接把整个 Node 进程崩掉。真正的结果永远
    // 看 child 的 'exit'/'error'，这里只是不让 EPIPE 冒泡成未捕获异常。
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      settle(() => reject(new HostLockSystemError(`无法启动 flock：${err.message}`)));
    });
    child.on("exit", (code) => {
      settle(() => {
        if (code === CONFLICT_EXIT_CODE) {
          reject(new HostLockBusyError("Claude 跨项目锁当前被占用（可能是 Morrow 正在使用），请稍后重试。"));
        } else {
          reject(new HostLockSystemError(`Claude 跨项目锁获取失败（flock 退出码 ${code}）：${stderrBuf.trim() || "无 stderr 输出"}`));
        }
      });
    });

    // 这时候 flock 可能还在等锁——管道会先缓着，真正 exec 进 cat 之后才会被
    // 读到、回显。写失败（比如已经因为冲突退出、读端关了）静默吞掉，交给
    // 上面的 'exit' handler 给出最终结果。
    child.stdin.write(`${sentinel}\n`, () => {});
  });
}

async function writeStatus(lockDir, { kind, pid, startedAt }) {
  const tmp = path.resolve(lockDir, `.status.${process.pid}.${randomUUID()}.tmp`);
  const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, owner: "cyberboss", agent: "claude", kind, startedAt, pid });
  await writeFile(tmp, body, { mode: 0o664 });
  // 显式补一次——mode 参数一样会被 umask 削，这里要的是"不管 umask 是多少，
  // group 都能读写"，umask 022 会把 664 削成 644，chmod 再修一次不受 umask 影响。
  await chmod(tmp, 0o664);
  await rename(tmp, statusFilePath(lockDir));
}

// 只清理"确认是自己写的"那份 status——用 pid+startedAt 双重匹配，不是"文件存在就删"。
// 正常情况下独占锁下不该有别人的 status 混进来；如果真出现不匹配，说明有异常，
// 保守起见留着不动，交给下一个真正拿到锁的人覆盖，而不是在这里瞎猜着删掉。
async function clearOwnStatus(lockDir, expectedPid, expectedStartedAt) {
  try {
    const parsed = JSON.parse(await readFile(statusFilePath(lockDir), "utf8"));
    if (parsed.pid === expectedPid && parsed.startedAt === expectedStartedAt) {
      await rm(statusFilePath(lockDir), { force: true });
    }
  } catch {
    // 文件不存在，或者读/解析失败——没什么可清的
  }
}

/**
 * 获取跨项目锁，可阻塞等待。只在真正要接触 Claude CLI/OAuth 的那一段调用——
 * 拿不到（busy 或系统错误）就直接抛错，调用方不应该在 catch 之外启动 Claude。
 *
 * @param {{ lockDir: string, kind: string, timeoutMs: number }} opts
 *   timeoutMs<=0 表示非阻塞（-w 0，立刻返回，用于 try-lock 语义）。
 * @returns {Promise<{ pid: number, release: () => Promise<void> }>}
 */
async function acquireHostLock({ lockDir, kind, timeoutMs }) {
  const child = await spawnHolder(lockDir, timeoutMs);
  const pid = child.pid;
  const startedAt = new Date().toISOString();

  try {
    await writeStatus(lockDir, { kind, pid, startedAt });
  } catch (err) {
    // status 写失败不该拦住已经到手的真锁——flock 才是真值，status 只是观测层，
    // 这里只留痕，不影响调用方继续往下走。
    console.error(`[cyberboss][host-lock] status.json 写入失败（不影响锁本身）：${err.message}`);
  }

  let released = false;
  return {
    pid,
    async release() {
      if (released) return;
      released = true;
      await clearOwnStatus(lockDir, pid, startedAt);
      // stdin.end() 发 EOF；cat 读到 EOF 退出，flock 持有的 fd 随之关闭、锁释放。
      await new Promise((resolvePromise) => {
        child.once("exit", () => resolvePromise());
        child.stdin.end();
      });
    },
  };
}

// Pulse/scheduled intentions 用的非阻塞 try-lock——契约形状对齐
// intentions-store.js 的 executeDueIntentions 已经在测试里钉住的 { acquired, release }。
// 忙（HostLockBusyError）和系统错误都归一成 acquired:false——调用方只关心"这次要不
// 要跳过"，busy 是预期路径，系统错误则额外打一条 error log 方便运维发现，但同样
// 不阻塞、不重试、不抢占：这就是"绝不能抢占 Morrow"的字面落地。
async function tryAcquireHostLock({ lockDir, kind }) {
  try {
    const lock = await acquireHostLock({ lockDir, kind, timeoutMs: 0 });
    return { acquired: true, release: lock.release };
  } catch (error) {
    if (error instanceof HostLockBusyError) {
      return { acquired: false, release: async () => {} };
    }
    console.error(`[cyberboss][host-lock] try-lock 系统错误，按"跳过"处理：${error.message}`);
    return { acquired: false, release: async () => {} };
  }
}

module.exports = { acquireHostLock, tryAcquireHostLock, HostLockBusyError, HostLockSystemError };
