const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { createSenderGate } = require("./sender-gate");
const { TurnGateStore } = require("./turn-gate-store");
const { buildInboundDraft, mergeBufferedInboundTexts, formatWechatLocalTime } = require("./inbound-turn");
const { createCurrentStateStore } = require("./current-state-store");
const { createEpisodeStore } = require("./episode-store");
const { createMemoryStore } = require("./memory-store");
const { createIntentionsStore, executeDueIntentions } = require("./intentions-store");
const { createTurnCoordinator } = require("./turn-coordinator");
const { StateCorruptionError } = require("./json-store");
const { acquireHostLock, tryAcquireHostLock, HostLockBusyError, HostLockSystemError } = require("./host-lock");
const { runAclPreflightOrThrow } = require("../adapters/runtime/claudecode");

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// Single sender, single workspace: there is exactly one turn-gate scope for the
// whole process (no per-thread/per-workspace fan-out like upstream Cyberboss).
const SCOPE_BINDING_KEY = "cyberboss";

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.runtimeAdapter = createClaudeCodeRuntimeAdapter(config);
    this.senderGate = createSenderGate(config);
    this.turnGateStore = new TurnGateStore();
    this.currentStateStore = createCurrentStateStore(config);
    this.episodeStore = createEpisodeStore(config);
    this.memoryStore = createMemoryStore(config);
    this.intentionsStore = createIntentionsStore(config);
    this.turnCoordinator = createTurnCoordinator({
      currentStateStore: this.currentStateStore,
      episodeStore: this.episodeStore,
      memoryStore: this.memoryStore,
      intentionsStore: this.intentionsStore,
    });
    this.pendingMessages = [];
    // Bubble merge (session 3 retune): idleTimer resets per message, maxWaitTimer
    // is set once per batch on the first message and never resets — whichever
    // fires first flushes. See scheduleMergeFlush/clearMergeTimers.
    this.idleTimer = null;
    this.maxWaitTimer = null;
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

    // Spec §2 fail-closed guarantee: load every active state file once at boot.
    // A corrupt file must stop the process before it accepts any WeChat
    // traffic — proceeding on a guessed/reset default would silently diverge
    // from whatever the user last saw.
    this.loadAllStoresOrExit();

    // Session 3: one more call site of the same synchronous ACL preflight the
    // runtime adapter already runs before every turn (docs/credential-acl-install.md) —
    // not a new mechanism, just run once here too so a systemd-started process
    // fails closed before it ever accepts a WeChat message, instead of only
    // discovering a stale ACL grant on the first real turn.
    try {
      await runAclPreflightOrThrow();
    } catch (error) {
      console.error(`[cyberboss] FATAL: startup acl preflight failed: ${formatErrorMessage(error)}`);
      process.exit(1);
    }

    const account = this.channelAdapter.resolveAccount();
    await this.channelAdapter.loadSyncBuffer();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id} runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] allowedSenderId=${this.senderGate.getAllowedSenderId() || "(bootstrap pending)"}`);
    console.log("[cyberboss] bridge loop started; waiting for WeChat messages.");

    const shutdown = createShutdownController(async () => {
      this.clearMergeTimers();
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
      this.clearMergeTimers();
    }
  }

  loadAllStoresOrExit() {
    try {
      this.currentStateStore.load();
      this.episodeStore.ensureCurrent(new Date().toISOString());
      this.memoryStore.load();
      this.intentionsStore.load();
    } catch (error) {
      if (error instanceof StateCorruptionError) {
        console.error(`[cyberboss] FATAL: ${error.message}`);
        console.error("[cyberboss] refusing to start with corrupt state — fix or restore the file by hand, nothing is auto-reset.");
        process.exit(1);
      }
      throw error;
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

  // Spec 五 bubble merge, session-3 retune: idle-debounce with a hard cap instead
  // of a flat 10s wait (see scheduleMergeFlush). Spec 四 unchanged: while a turn
  // is in flight, further messages collapse into one pending batch and flush
  // immediately (no merge timer at all) once the gate frees — that recursive
  // flushPendingBatch()-at-the-end path is untouched by this retune.
  bufferInboundMessage(prepared) {
    const isFirstOfBatch = this.pendingMessages.length === 0;
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
    this.scheduleMergeFlush(isFirstOfBatch);
  }

  // idleTimer resets on every message (debounce: keep waiting while the user is
  // still typing bubbles). maxWaitTimer is armed once, on the first message of a
  // new batch, and never reset — it's the hard cap so a steady trickle of
  // messages can't push the flush out indefinitely. Whichever fires first wins;
  // triggerMergeFlush() clears both so there's never a double flush.
  scheduleMergeFlush(isFirstOfBatch) {
    this.clearIdleTimer();
    if (isFirstOfBatch) {
      this.clearMaxWaitTimer();
      this.maxWaitTimer = setTimeout(() => this.triggerMergeFlush(), this.config.inboundMaxWaitMs);
    }
    this.idleTimer = setTimeout(() => this.triggerMergeFlush(), this.config.inboundIdleDelayMs);
  }

  triggerMergeFlush() {
    this.clearMergeTimers();
    void this.flushPendingBatch().catch((error) => {
      console.error(`[cyberboss] flush failed: ${formatErrorMessage(error)}`);
    });
  }

  clearMergeTimers() {
    this.clearIdleTimer();
    this.clearMaxWaitTimer();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  clearMaxWaitTimer() {
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
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
    const receivedAtIso = latest.receivedAt;
    const sourceTurnId = latest.messageId || `turn_${crypto.randomUUID()}`;

    this.turnGateStore.begin(SCOPE_BINDING_KEY, this.config.workspaceRoot);
    let lock = null;
    let logPayload = { mode: "reply", episodeId: "", rolloverReason: "none", isError: false };
    try {
      // Real WeChat turns may *wait* for the shared cross-project lock (Morrow
      // could be mid-turn) — no one is staring at a spinner the way Morrow's
      // chat UI is, so this can afford to wait, but not forever. Busy-after-
      // timeout and any system error both land in the catch below like any
      // other turn failure — the whole batch fails cleanly, typing stops, the
      // turn gate still releases.
      lock = await acquireHostLock({
        lockDir: this.config.hostLockDir,
        kind: "wechat_turn",
        timeoutMs: this.config.hostLockWaitMs,
      });

      const prepared = await this.turnCoordinator.prepareTurn({
        agentName: this.config.agentName,
        receivedAtIso,
        receivedAtLocal: formatWechatLocalTime(receivedAtIso),
        mergedText,
      });

      const startedAt = Date.now();
      const result = await this.runtimeAdapter.sendSingleTurn({ text: prepared.turnText });
      const durationMs = Date.now() - startedAt;

      const applyResult = await this.turnCoordinator.applyTurn({
        structuredResult: result.structuredResult || {},
        turnUserText: mergedText,
        receivedAtIso,
        sourceTurnId,
        prepared,
        sendReply: async (replyText) => {
          return this.channelAdapter.sendText({
            userId: latest.senderId,
            text: replyText,
            contextToken: latest.contextToken,
          }).then(() => true).catch((error) => {
            console.error(`[cyberboss] send failed: ${formatErrorMessage(error)}`);
            return false;
          });
        },
      });

      logPayload = {
        mode: "reply",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        durationMs,
        episodeId: applyResult.episodeId || prepared.episode.id,
        rolloverReason: applyResult.applied ? applyResult.rolloverAction : (applyResult.reason || "unknown"),
        isError: Boolean(result.isError) || !applyResult.applied,
      };

      if (!applyResult.applied) {
        console.warn(`[cyberboss] turn not applied: ${applyResult.reason}${applyResult.errors ? ` ${JSON.stringify(applyResult.errors)}` : ""}`);
      }
      // Stop typing regardless of outcome (sent, silent, invalid, or rejected) —
      // the user should never be left seeing "typing..." forever.
      await this.channelAdapter.sendTyping({ userId: latest.senderId, status: 0 }).catch(() => {});
    } catch (error) {
      if (error instanceof HostLockBusyError) {
        console.error(`[cyberboss] host lock busy after ${this.config.hostLockWaitMs}ms wait, turn dropped: ${formatErrorMessage(error)}`);
      } else if (error instanceof HostLockSystemError) {
        console.error(`[cyberboss] host lock system error, turn dropped: ${formatErrorMessage(error)}`);
      } else {
        console.error(`[cyberboss] turn failed: ${formatErrorMessage(error)}`);
      }
      logPayload.isError = true;
      await this.channelAdapter.sendTyping({ userId: latest.senderId, status: 0 }).catch(() => {});
    } finally {
      // Spec §7: never log message bodies, only metadata.
      console.log(JSON.stringify(logPayload));
      if (lock) {
        await lock.release();
      }
      this.turnGateStore.releaseScope(SCOPE_BINDING_KEY, this.config.workspaceRoot);
    }

    // Anything that arrived while this turn was running collapsed into pendingMessages;
    // flush it immediately as its own batch (spec 四: one pending batch, no re-queueing).
    if (this.pendingMessages.length) {
      await this.flushPendingBatch();
    }
  }

  // Spec §6 execution interface, wired for real in session 3: who actually
  // *calls* this (Pulse's trigger source) is still open — see docs/cyberboss-lite-status.md
  // "For session 3" — but the call itself is complete and safe to invoke today:
  // non-blocking try-lock (never waits, never preempts Morrow — HostLockBusyError
  // just means "skip this tick"), gated by config.enableScheduledIntentions
  // (still false until that's explicitly flipped), and sendFn is a plain WeChat
  // delivery — never a Claude turn, so it can't recursively create intentions/
  // memory/handoff (spec §6's explicit ban).
  async runDueIntentionsCheck() {
    const allowedSenderId = this.senderGate.getAllowedSenderId();
    if (!allowedSenderId) {
      return { executed: [], skippedReason: "no_allowed_sender" };
    }

    const state = this.intentionsStore.load();
    const result = await executeDueIntentions({
      store: this.intentionsStore,
      state,
      nowMs: Date.now(),
      enabled: this.config.enableScheduledIntentions,
      tryLock: () => tryAcquireHostLock({ lockDir: this.config.hostLockDir, kind: "scheduled_intention" }),
      sendFn: async (intention) => {
        const text = buildIntentionMessageText(intention);
        if (!text) {
          return;
        }
        await this.channelAdapter.sendText({ userId: allowedSenderId, text });
      },
    });

    if (result.state) {
      this.intentionsStore.save(result.state);
    }
    if (result.executed.length) {
      // Spec §7: never log message bodies, only metadata.
      console.log(JSON.stringify({ mode: "scheduled_intention", executed: result.executed }));
    }
    return result;
  }
}

// Interpretation call (mirrors session 2's documented gap-fills): sendFn must be
// plain delivery, never a second Claude call, so the outbound text has to come
// straight from data the model already wrote at creation time. `reason` is the
// model's own natural-language justification for the intention (spec §6
// required field) and is the closest thing to "what to say" without a rephrase
// call; `context` is optional supplementary detail appended when present.
function buildIntentionMessageText(intention) {
  const reason = String(intention?.reason || "").trim();
  const context = String(intention?.context || "").trim();
  if (!reason) {
    return "";
  }
  return context ? `${reason}\n${context}` : reason;
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
