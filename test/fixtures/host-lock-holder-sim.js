// Independent child-process fixture used by test/host-lock.test.js — simulates
// "Cyberboss's main process is mid-turn, then gets SIGKILL'd/OOM-killed". This
// has to be a real, separate OS process (not an in-process mock) so that
// sending it SIGKILL from the test is actually killing a process, not just
// tearing down a JS object.
//
// Usage: CYBERBOSS_HOST_LOCK_HOLDER_SIM_DIR=<dir> node host-lock-holder-sim.js
// Once it holds the lock it prints one line of JSON { pid, holderPid } to
// stdout, then hangs forever — deliberately never releases or cleans up,
// waiting for the test to kill -9 this process from outside.
const { acquireHostLock } = require("../../src/core/host-lock");

(async () => {
  const lockDir = process.env.CYBERBOSS_HOST_LOCK_HOLDER_SIM_DIR;
  const lock = await acquireHostLock({ lockDir, kind: "turn", timeoutMs: 5000 });
  console.log(JSON.stringify({ pid: process.pid, holderPid: lock.pid }));
  await new Promise(() => {});
})();
