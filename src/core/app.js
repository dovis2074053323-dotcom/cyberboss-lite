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
const { createTaskerSnapshotClient } = require("../adapters/observation/tasker-snapshot");
const { createCompanionObservationClient } = require("../adapters/observation/companion-observation");
const { createPetStateClient } = require("../adapters/observation/pet-state");
const { createObservationBundleBuilder } = require("./observation-bundle");
const { createSystemMessageQueueStore } = require("./system-message-queue-store");
const { createCheckinConfigStore } = require("./checkin-config-store");
const { createSystemCheckinPoller } = require("../app/system-checkin-poller");
const { createEventOpportunityStateStore } = require("./event-opportunity-state-store");
const { createEventOpportunityPoller } = require("../app/event-opportunity-poller");
const { PROACTIVE_RESULT_JSON_SCHEMA } = require("./proactive-result-schema");
const { processProactiveMessage } = require("./proactive-turn-runner");

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
    // Pulse (session 3): drives Future Intentions only, no autonomous
    // "reach out to chat" heartbeat. Session 4 extends the same 60s tick to
    // also drain the proactive queue (runProactiveDrainTick) under the same
    // pulseTickInFlight reentrancy guard — see startPulse/runPulseTick below.
    this.pulseTimer = null;
    this.pulseTickInFlight = false;

    // Session 4 (Cyberboss Proactive + keke-overflow Companion rework, task
    // #14): observation sources are optional at boot — CYBERBOSS_TASKER_*/
    // CYBERBOSS_COMPANION_* aren't set in production yet (task #9-11 added
    // the adapters, didn't wire real credentials in). A stub that rejects
    // with a clear "not configured" error keeps the process bootable either
    // way; observation-bundle.js already treats a rejected source as
    // `{error}` rather than failing the whole bundle, so this degrades to
    // "local-only bundle" instead of refusing to start.
    this.taskerSnapshotClient = createTaskerSnapshotClientOrStub(config);
    this.companionObservationClient = createCompanionObservationClientOrStub(config);
    this.petStateClient = createPetStateClientOrStub(config);
    this.observationBundleBuilder = createObservationBundleBuilder({
      currentStateStore: this.currentStateStore,
      memoryStore: this.memoryStore,
      taskerSnapshotClient: this.taskerSnapshotClient,
      companionObservationClient: this.companionObservationClient,
    });

    // Stochastic Pulse (task #9-11) and Event Opportunity (task #13) share one
    // queue (system-message-queue-store) and one drain consumer
    // (runProactiveDrainTick, folded into the existing Pulse tick below) —
    // both pollers only ever enqueue, never call Claude themselves.
    this.systemMessageQueueStore = createSystemMessageQueueStore(config);
    this.checkinConfigStore = createCheckinConfigStore(config);
    this.systemCheckinPoller = createSystemCheckinPoller({
      queueStore: this.systemMessageQueueStore,
      checkinConfigStore: this.checkinConfigStore,
      buildObservationBundle: () => this.observationBundleBuilder.build(),
      onLog: (msg) => console.log(`[cyberboss] ${msg}`),
    });
    this.eventOpportunityStateStore = createEventOpportunityStateStore(config);
    this.eventOpportunityPoller = createEventOpportunityPoller({
      queueStore: this.systemMessageQueueStore,
      stateStore: this.eventOpportunityStateStore,
      buildObservationBundle: () => this.observationBundleBuilder.build(),
      intervalMs: config.eventOpportunityIntervalMs,
      cooldownMs: config.eventOpportunityCooldownMs,
      longSilenceMs: config.eventOpportunityLongSilenceMs,
      onLog: (msg) => console.log(`[cyberboss] ${msg}`),
    });
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

    this.startPulse();
    this.systemCheckinPoller.start();
    this.eventOpportunityPoller.start();

    const shutdown = createShutdownController(async () => {
      this.clearMergeTimers();
      this.stopPulse();
      this.systemCheckinPoller.stop();
      this.eventOpportunityPoller.stop();
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
      this.stopPulse();
      this.systemCheckinPoller.stop();
      this.eventOpportunityPoller.stop();
    }
  }

  // Pulse (session 3, deliberately minimal): a 60s tick (config.pulseIntervalMs)
  // that does exactly one thing — call runDueIntentionsCheck(), which is a
  // real no-op (no lock attempt, no send, no Claude call) whenever nothing is
  // due. This is *not* an autonomous "check in just to be present" heartbeat —
  // it only ever drives already-created reminder/check_in Future Intentions.
  // resume_topic is untouched: still only injected on the next real inbound
  // turn, never sent proactively by Pulse (spec §6 already said this; Pulse
  // doesn't change it).
  //
  // Session 4 (task #14): the same tick also calls runProactiveDrainTick(),
  // which *can* reach Claude (unlike the intentions check) — Stochastic Pulse
  // and Event Opportunity only ever enqueue, this is the one place that
  // actually drains system-message-queue-store. Riding the same 60s interval
  // and the same pulseTickInFlight guard rather than adding a fourth timer:
  // both halves already need the identical "never run concurrently with
  // yourself, never preempt Morrow" posture, so there is nothing a separate
  // timer would buy.
  startPulse() {
    this.pulseTimer = setInterval(() => {
      void this.runPulseTick();
    }, this.config.pulseIntervalMs);
  }

  stopPulse() {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  // Reentrancy guard: if a previous tick is still awaiting a WeChat send (or
  // waiting out a busy non-blocking try-lock's own async round-trip) when the
  // next interval fires, skip — two overlapping ticks reading/writing
  // intentions.json concurrently is exactly the kind of double-send this
  // guard exists to rule out. The store's own atomic writes protect against
  // corruption either way, but not against two ticks both deciding the same
  // pending intention is still due before either one's resolve() lands.
  //
  // The two halves are independent try/catches so one failing (e.g. a
  // malformed intention) never skips the other — both still run under the
  // same in-flight guard, so they still never overlap with the *next* tick.
  async runPulseTick() {
    if (this.pulseTickInFlight) {
      return;
    }
    this.pulseTickInFlight = true;
    try {
      await this.runDueIntentionsCheck().catch((error) => {
        console.error(`[cyberboss] pulse tick (intentions) failed: ${formatErrorMessage(error)}`);
      });
      await this.runProactiveDrainTick().catch((error) => {
        console.error(`[cyberboss] pulse tick (proactive drain) failed: ${formatErrorMessage(error)}`);
      });
    } finally {
      this.pulseTickInFlight = false;
    }
  }

  // Task #14: drains system-message-queue-store (populated by Stochastic
  // Pulse / Event Opportunity) and, for each queued message, runs exactly one
  // real proactive Claude turn against proactive-result-schema.js's narrow
  // contract and applies whatever it decided. Non-blocking try-lock, same as
  // runDueIntentionsCheck — busy (Morrow or a real WeChat turn holding the
  // lock) just means "skip this tick, the message stays queued, try again
  // next tick" (hasPending() on the producer side already stops a new
  // wake-up from stacking on top of an undrained one).
  //
  // No allowedSenderId yet (bootstrap not done) is a hard skip before even
  // touching the lock: a proactive turn that can only ever end in `silent`
  // (nowhere to send `send_message` to) isn't worth a Claude call.
  async runProactiveDrainTick() {
    const queueState = this.systemMessageQueueStore.load();
    if (!this.systemMessageQueueStore.hasPending(queueState)) {
      return { drained: false, reason: "empty" };
    }

    const allowedSenderId = this.senderGate.getAllowedSenderId();
    if (!allowedSenderId) {
      return { drained: false, reason: "no_allowed_sender" };
    }

    const lock = await tryAcquireHostLock({ lockDir: this.config.hostLockDir, kind: "proactive_turn" });
    if (!lock.acquired) {
      return { drained: false, reason: "lock_busy" };
    }

    try {
      const { drained, state: nextQueueState } = this.systemMessageQueueStore.drainAll(queueState);
      this.systemMessageQueueStore.save(nextQueueState);

      const results = [];
      // Producers only enqueue when hasPending() was false, so in practice
      // this is 0 or 1 messages — processed sequentially regardless, so a
      // rare race that let two land here never fires two Claude calls at once.
      for (const message of drained) {
        const result = await processProactiveMessage(message, {
          callRuntime: (prompt) => this.runtimeAdapter.sendSingleTurn({ text: prompt, resultSchema: PROACTIVE_RESULT_JSON_SCHEMA }),
          // Task #12 round 2: a real on-demand request, not a re-read of
          // whatever was last passively collected (that was this session's
          // first pass — corrected once flagged). Push a fresh requestId via
          // keke_state's Realtime channel (pet-state.js), then poll
          // companion_events for the device's answer (companion-observation.js)
          // — bounded by config.contextSnapshotTimeoutMs, so an unreachable
          // device degrades to an error the round-2 prompt renders as
          // "(unavailable)" rather than hanging the drain tick. Never a
          // screenshot/image — see AccessibilityPrivacyFilter.kt on the
          // device side for what does and doesn't get captured.
          fetchRefreshedContext: async () => {
            const requestId = crypto.randomUUID();
            await this.petStateClient.requestContextSnapshot({ requestId });
            return this.companionObservationClient.getContextSnapshot({
              requestId,
              timeoutMs: this.config.contextSnapshotTimeoutMs,
              pollIntervalMs: this.config.contextSnapshotPollIntervalMs,
            });
          },
          sendMessage: (text) => this.channelAdapter.sendText({ userId: allowedSenderId, text }).then(() => true).catch((error) => {
            console.error(`[cyberboss] proactive send failed: ${formatErrorMessage(error)}`);
            return false;
          }),
          pushExpression: (payload) => this.petStateClient.pushExpression(payload),
          markAgentMessageSent: (nowIso) => {
            const state = this.currentStateStore.load();
            this.currentStateStore.save(this.currentStateStore.applyPatch(state, {}, { lastAgentMessageAt: nowIso }));
          },
          onLog: (msg) => console.log(`[cyberboss] ${msg}`),
        });
        results.push(result);
        // Spec §7 posture carried over: never log message bodies, only metadata.
        console.log(JSON.stringify({ mode: "proactive_turn", source: message.source, action: result.action, sent: result.sent }));
      }
      return { drained: true, results };
    } finally {
      await lock.release();
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

  // Spec §6 execution interface, wired for real in session 3 and now called by
  // Pulse's 60s tick (runPulseTick above). Non-blocking try-lock (never waits,
  // never preempts Morrow — HostLockBusyError just means "skip this tick, try
  // again next tick"), gated by config.enableScheduledIntentions, and sendFn is
  // a plain WeChat delivery — never a Claude turn, so it can't recursively
  // create intentions/memory/handoff (spec §6's explicit ban).
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

// Observation credentials (CYBERBOSS_TASKER_SUPABASE_*/CYBERBOSS_COMPANION_SUPABASE_*)
// aren't set in production yet (task #9-11 added the adapters, not the real
// keys) — createSupabaseRestClient throws synchronously if baseUrl/anonKey are
// missing, so constructing the real adapter unconditionally in CyberbossApp's
// constructor would make the whole process fail to boot. These stubs keep
// boot unconditional; the rejection surfaces per-call instead, exactly where
// observation-bundle.js already expects a source to possibly fail (it catches
// and turns it into `{error}` rather than failing the whole bundle).
function createTaskerSnapshotClientOrStub(config) {
  if (config.taskerSupabaseUrl && config.taskerSupabaseAnonKey) {
    return createTaskerSnapshotClient(config);
  }
  return {
    async getSnapshot() {
      throw new Error("tasker observation not configured (CYBERBOSS_TASKER_SUPABASE_URL/ANON_KEY unset)");
    },
  };
}

function createCompanionObservationClientOrStub(config) {
  if (config.companionSupabaseUrl && config.companionSupabaseAnonKey) {
    return createCompanionObservationClient(config);
  }
  return {
    async getRecentSegments() {
      throw new Error("companion observation not configured (CYBERBOSS_COMPANION_SUPABASE_URL/ANON_KEY unset)");
    },
  };
}

function createPetStateClientOrStub(config) {
  if (config.companionSupabaseUrl && config.companionSupabaseAnonKey) {
    return createPetStateClient(config);
  }
  return {
    async pushExpression() {
      throw new Error("pet-state not configured (CYBERBOSS_COMPANION_SUPABASE_URL/ANON_KEY unset)");
    },
  };
}

// sendFn must be plain delivery, never a second Claude call, so the outbound
// text has to come straight from data the model already wrote at creation
// time. `deliveryText` is the field meant for that (see result-schema.js's
// per-item intentions validation and intentions-store.js's create()) — `reason`
// is only the model's internal justification for *why* the intention exists
// and must never be sent as-is (real bug found live: a reminder for "cc很萌"
// went out as "用户要求五分钟后发送指定文字" because this function used to send
// `reason`). Fallback to `reason` only covers intentions persisted before this
// field existed; every intention created after this fix always has a real
// `deliveryText`.
function buildIntentionMessageText(intention) {
  const deliveryText = String(intention?.deliveryText || "").trim();
  const reason = String(intention?.reason || "").trim();
  const context = String(intention?.context || "").trim();
  const primary = deliveryText || reason;
  if (!primary) {
    return "";
  }
  return context ? `${primary}\n${context}` : primary;
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

module.exports = { CyberbossApp, buildIntentionMessageText };
