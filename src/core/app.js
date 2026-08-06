const fs = require("fs");
const path = require("path");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { createSenderGate } = require("./sender-gate");
const { TurnGateStore } = require("./turn-gate-store");
const { buildInboundDraft, mergeBufferedInboundTexts, assembleRuntimeTurnText } = require("./inbound-turn");

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// Single sender, single workspace: there is exactly one turn-gate scope for the
// whole process (no per-thread/per-workspace fan-out like upstream Cyberboss).
const SCOPE_BINDING_KEY = "cyberboss";

// Stub for the session-3 host-wide `/run/agent-runtime` flock. Session 1 only has
// the in-process TurnGateStore; this hook exists so wiring the real flock later is
// a local change, not a re-plumbing of app.js. Non-blocking try-lock semantics
// (spec 四: Pulse/intentions use try-lock and skip when busy) belong here too, once
// Pulse exists (session 3).
const hostLock = {
  async tryAcquire() {
    return { acquired: true, release: () => {} };
  },
};

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.runtimeAdapter = createClaudeCodeRuntimeAdapter(config);
    this.senderGate = createSenderGate(config);
    this.turnGateStore = new TurnGateStore();
    this.pendingMessages = [];
    this.mergeTimer = null;
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      allowedSenderId: this.senderGate.getAllowedSenderId() || "(bootstrap: not yet captured)",
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    // No session persistence means nothing from a previous process is ever valid;
    // a crash/OOM/`systemctl stop` mid-turn skips the runtime's own `finally`
    // cleanup, so sweep any orphaned per-turn CLAUDE_CONFIG_DIRs (and their
    // credential symlinks) left behind before accepting new messages.
    sweepStaleClaudeConfigDirs(this.config.claudeConfigDirRoot);

    const account = this.channelAdapter.resolveAccount();
    await this.channelAdapter.loadSyncBuffer();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id} runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] allowedSenderId=${this.senderGate.getAllowedSenderId() || "(bootstrap pending)"}`);
    console.log("[cyberboss] bridge loop started; waiting for WeChat messages.");

    const shutdown = createShutdownController(async () => {
      this.clearMergeTimer();
    });

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: this.channelAdapter.loadSyncBuffer(),
            timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          });
          consecutiveFailures = 0;
          const messages = Array.isArray(response?.msgs) ? response.msgs : [];
          for (const message of messages) {
            if (shutdown.stopped) {
              break;
            }
            this.handleIncomingMessage(message);
          }
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }
          consecutiveFailures += 1;
          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      this.clearMergeTimer();
    }
  }

  handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }

    // Spec 五: text only. Attachment-only bubbles are dropped, not answered.
    const prepared = buildInboundDraft(normalized);
    if (!prepared.text) {
      return;
    }

    const gateResult = this.senderGate.evaluate(prepared.senderId);
    if (gateResult === "rejected") {
      console.warn(`[cyberboss] sender rejected sender=${redactId(prepared.senderId)}`);
      return;
    }
    if (gateResult === "bootstrap_captured") {
      console.log(`[cyberboss] bootstrap captured sender=${redactId(prepared.senderId)} — no reply sent, restart with CYBERBOSS_ALLOWED_SENDER_ID to lock it in`);
      return;
    }

    this.bufferInboundMessage(prepared);
  }

  // Spec 五: 10s bubble merge. Spec 四: while a turn is in flight, further messages
  // collapse into one pending batch and flush only once the gate frees.
  bufferInboundMessage(prepared) {
    this.pendingMessages.push(prepared);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});

    if (this.turnGateStore.isPending(SCOPE_BINDING_KEY, this.config.workspaceRoot)) {
      // A turn is already running; this message waits and will be flushed on release.
      return;
    }
    this.scheduleMergeFlush();
  }

  scheduleMergeFlush() {
    this.clearMergeTimer();
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null;
      void this.flushPendingBatch().catch((error) => {
        console.error(`[cyberboss] flush failed: ${formatErrorMessage(error)}`);
      });
    }, this.config.inboundMergeWindowMs);
  }

  clearMergeTimer() {
    if (this.mergeTimer) {
      clearTimeout(this.mergeTimer);
      this.mergeTimer = null;
    }
  }

  async flushPendingBatch() {
    if (!this.pendingMessages.length) {
      return;
    }
    if (this.turnGateStore.isPending(SCOPE_BINDING_KEY, this.config.workspaceRoot)) {
      return;
    }

    const batch = this.pendingMessages;
    this.pendingMessages = [];
    const latest = batch[batch.length - 1];
    const mergedText = mergeBufferedInboundTexts(batch);

    this.turnGateStore.begin(SCOPE_BINDING_KEY, this.config.workspaceRoot);
    const lock = await hostLock.tryAcquire();
    try {
      const turnText = assembleRuntimeTurnText({ text: mergedText, receivedAt: latest.receivedAt });
      const startedAt = Date.now();
      const result = await this.runtimeAdapter.sendSingleTurn({ text: turnText });
      console.log(JSON.stringify({
        mode: "reply",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        durationMs: Date.now() - startedAt,
        lockResult: "acquired",
        isError: result.isError,
      }));

      await this.channelAdapter.sendTyping({ userId: latest.senderId, status: 0 }).catch(() => {});
      if (result.replyText) {
        const sendOk = await this.channelAdapter.sendText({
          userId: latest.senderId,
          text: result.replyText,
          contextToken: latest.contextToken,
        }).then(() => true).catch((error) => {
          console.error(`[cyberboss] send failed: ${formatErrorMessage(error)}`);
          return false;
        });
        console.log(JSON.stringify({ mode: "reply", sendResult: sendOk ? "ok" : "failed" }));
      }
    } catch (error) {
      console.error(`[cyberboss] turn failed: ${formatErrorMessage(error)}`);
      await this.channelAdapter.sendTyping({ userId: latest.senderId, status: 0 }).catch(() => {});
    } finally {
      lock.release();
      this.turnGateStore.releaseScope(SCOPE_BINDING_KEY, this.config.workspaceRoot);
    }

    // Anything that arrived while this turn was running collapsed into pendingMessages;
    // flush it immediately as its own batch (spec 四: one pending batch, no re-queueing).
    if (this.pendingMessages.length) {
      await this.flushPendingBatch();
    }
  }
}

function sweepStaleClaudeConfigDirs(configDirRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(configDirRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(configDirRoot, entry);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      console.warn(`[cyberboss] swept stale claude config dir ${entry}`);
    } catch (error) {
      console.error(`[cyberboss] failed to sweep ${entry}: ${formatErrorMessage(error)}`);
    }
  }
}

function createShutdownController(onStop) {
  let stopped = false;
  let disposed = false;
  const handler = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    void onStop();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function redactId(value) {
  const text = String(value || "");
  return text.length > 4 ? `${text.slice(0, 2)}***${text.slice(-2)}` : "***";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { CyberbossApp };
