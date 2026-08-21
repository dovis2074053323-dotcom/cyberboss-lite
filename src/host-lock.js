const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { chmod, mkdir, readFile, rename, rm, writeFile } = require("fs/promises");
const path = require("path");

const FLOCK_BIN = "/usr/bin/flock";
const CAT_BIN = "/bin/cat";
const CONFLICT_EXIT_CODE = 42;

class HostLockBusyError extends Error {}
class HostLockSystemError extends Error {}

async function acquireHostLock({ lockDir, kind, timeoutMs = 0 }) {
  await mkdir(lockDir, { recursive: true });
  const child = await spawnHolder(lockDir, timeoutMs);
  const pid = child.pid;
  const startedAt = new Date().toISOString();

  try {
    await writeStatus(lockDir, { kind, pid, startedAt });
  } catch (error) {
    console.error(`[wechat-bot][host-lock] status write failed: ${error.message}`);
  }

  let released = false;
  return {
    pid,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await clearOwnStatus(lockDir, pid, startedAt);
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.stdin.end();
      });
    },
  };
}

function spawnHolder(lockDir, timeoutMs) {
  const nonBlocking = timeoutMs <= 0;
  const timeoutSec = nonBlocking ? 0 : Math.max(1, Math.ceil(timeoutMs / 1000));
  const sentinel = `wechat-lock-${randomUUID()}`;
  const args = [
    "-F",
    "-w",
    String(timeoutSec),
    "-E",
    String(CONFLICT_EXIT_CODE),
    path.resolve(lockDir, "claude.lock"),
    CAT_BIN,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(FLOCK_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(sentinel)) {
        settle(() => resolve(child));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.stdin.on("error", () => {});
    child.on("error", (error) => settle(() => reject(new HostLockSystemError(`could not start flock: ${error.message}`))));
    child.on("exit", (code) => settle(() => {
      if (code === CONFLICT_EXIT_CODE) {
        reject(new HostLockBusyError("shared Claude host lock is busy"));
      } else {
        reject(new HostLockSystemError(`flock exited with code ${code}: ${stderr.trim() || "no stderr"}`));
      }
    }));
    child.stdin.write(`${sentinel}\n`, () => {});
  });
}

async function writeStatus(lockDir, { kind, pid, startedAt }) {
  const temporary = path.resolve(lockDir, `.status.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({
    schemaVersion: 1,
    owner: "wechatbot",
    agent: "claude",
    kind,
    startedAt,
    pid,
  }), { mode: 0o664 });
  await chmod(temporary, 0o664);
  await rename(temporary, path.resolve(lockDir, "status.json"));
}

async function clearOwnStatus(lockDir, pid, startedAt) {
  try {
    const statusPath = path.resolve(lockDir, "status.json");
    const parsed = JSON.parse(await readFile(statusPath, "utf8"));
    if (parsed.pid === pid && parsed.startedAt === startedAt) {
      await rm(statusPath, { force: true });
    }
  } catch {
    // A missing or malformed status file does not affect flock.
  }
}

module.exports = { acquireHostLock, HostLockBusyError, HostLockSystemError };
