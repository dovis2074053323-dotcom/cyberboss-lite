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
const { createMorrowContextRelay } = require("../adapters/observation/morrow-context-relay");
const { createObservationBundleBuilder } = require("./observation-bundle");
const { createSystemMessageQueueStore } = require("./system-message-queue-store");
const { createEventOpportunityStateStore } = require("./event-opportunity-state-store");
const { createEventOpportunityPoller } = require("../app/event-opportunity-poller");
const { createProactiveBudgetStore } = require("./proactive-budget-store");
const { PROACTIVE_RESULT_JSON_SCHEMA, MANDATORY_PROACTIVE_RESULT_JSON_SCHEMA } = require("./proactive-result-schema");
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
    // Pulse remains the cheap 60s local tick for Future Intentions, mandatory
    // slots, and the proactive queue drain. Observation building and model
    // calls happen only after a queued candidate passes the drain gates.
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
    this.morrowContextRelay = createMorrowContextRelay(config);
    this.observationBundleBuilder = createObservationBundleBuilder({
      currentStateStore: this.currentStateStore,
      memoryStore: this.memoryStore,
      taskerSnapshotClient: this.taskerSnapshotClient,
      companionObservationClient: this.companionObservationClient,
    });

    // Event Opportunity and mandatory outreach slots share one queue and one
    // drain consumer. Both producers remain zero-model local schedulers.
    this.systemMessageQueueStore = createSystemMessageQueueStore(config);
    this.proactiveBudgetStore = createProactiveBudgetStore(config);
    this.eventOpportunityStateStore = createEventOpportunityStateStore(config);
    this.eventOpportunityPoller = createEventOpportunityPoller({
      queueStore: this.systemMessageQueueStore,
      stateStore: this.eventOpportunityStateStore,
      buildObservationBundle: () => this.observationBundleBuilder.build(),
      intervalMs: config.eventOpportunityIntervalMs,
      longSilenceMs: config.eventOpportunityLongSilenceMs,
      evidenceTtlMs: config.proactiveEvidenceTtlMs,
      canQueueOptional: () => this.proactiveBudgetStore.getOptionalEligibility(),
      onMetric: (metric) => this.proactiveBudgetStore.recordMetric(metric),
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
    this.logProactiveDayState();
    console.log("[cyberboss] bridge loop started; waiting for WeChat messages.");

    this.startPulse();
    this.eventOpportunityPoller.start();

    const shutdown = createShutdownController(async () => {
      this.clearMergeTimers();
      this.stopPulse();
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
      this.eventOpportunityPoller.stop();
    }
  }

  // The 60s pulse is deliberately cheap when there is no due work: Future
  // Intentions, mandatory-slot due/missed bookkeeping, and one shared queue
  // drain. It never builds observations on its own and never calls Claude
  // without a queued candidate.
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
      await this.retryMandatoryDeliveries().catch((error) => {
        console.error(`[cyberboss] pulse tick (mandatory delivery retry) failed: ${formatErrorMessage(error)}`);
      });
      await this.runMandatorySlotCheck().catch((error) => {
        console.error(`[cyberboss] pulse tick (mandatory slots) failed: ${formatErrorMessage(error)}`);
      });
      await this.runProactiveDrainTick().catch((error) => {
        console.error(`[cyberboss] pulse tick (proactive drain) failed: ${formatErrorMessage(error)}`);
      });
    } finally {
      this.pulseTickInFlight = false;
    }
  }

  async retryMandatoryDeliveries() {
    const allowedSenderId = this.senderGate.getAllowedSenderId();
    if (!allowedSenderId) return { retried: false, reason: "no_allowed_sender" };
    const pending = this.proactiveBudgetStore.pendingDeliveries();
    const results = [];
    for (const slot of pending) {
      try {
        await this.channelAdapter.sendText({ userId: allowedSenderId, text: slot.deliveryText });
        this.proactiveBudgetStore.markSlotSatisfied(slot.id);
        this.markAgentMessageSent();
        results.push({ slotId: slot.id, sent: true });
        console.log(`[cyberboss] mandatory ${slot.id} delivery retry sent`);
      } catch (error) {
        results.push({ slotId: slot.id, sent: false });
        console.error(`[cyberboss] mandatory ${slot.id} delivery retry failed: ${formatErrorMessage(error)}`);
      }
    }
    return { retried: results.length > 0, results };
  }

  markAgentMessageSent(nowIso = new Date().toISOString()) {
    const state = this.currentStateStore.load();
    this.currentStateStore.save(this.currentStateStore.applyPatch(state, {}, { lastAgentMessageAt: nowIso }));
  }

  logProactiveDayState() {
    const state = this.proactiveBudgetStore.load();
    console.log(JSON.stringify({
      mode: "proactive_budget",
      date: state.date,
      calls: `${state.totalCalls}/${this.proactiveBudgetStore.maxCallsPerDay}`,
      slots: state.slots.map((slot) => ({ id: slot.id, targetAt: slot.targetAt, satisfied: slot.satisfied, missed: slot.missed })),
    }));
  }

  async runMandatorySlotCheck(nowMs = Date.now()) {
    const expired = this.proactiveBudgetStore.markExpiredSlots(nowMs);
    for (const slotId of expired.missed) {
      const queueState = this.systemMessageQueueStore.load();
      const next = this.systemMessageQueueStore.removeWhere(queueState, (message) => message.forced && message.slotId === slotId);
      if (next.messages.length !== queueState.messages.length) this.systemMessageQueueStore.save(next);
      console.log(`[cyberboss] mandatory ${slotId} missed: window ended`);
    }

    const state = this.proactiveBudgetStore.load(nowMs);
    const due = state.slots.find((slot) => {
      const targetAt = new Date(slot.targetAt).getTime();
      const endAt = new Date(slot.endAt).getTime();
      return !slot.satisfied && !slot.missed && !slot.deliveryText && nowMs >= targetAt && nowMs < endAt;
    });
    if (!due) return { queued: false, reason: "none_due" };

    let queueState = this.systemMessageQueueStore.load();
    const pending = this.systemMessageQueueStore.peek(queueState);
    if (pending?.forced && pending.slotId === due.id) {
      return { queued: false, reason: "already_pending", slotId: due.id };
    }
    if (pending?.forced) {
      return { queued: false, reason: "queue_pending", slotId: pending.slotId || null };
    }

    const forcedMessage = {
      id: crypto.randomUUID(),
      source: "mandatory_slot",
      createdAt: new Date(nowMs).toISOString(),
      forced: true,
      slotId: due.id,
      reasons: [`mandatory_${due.id}`],
      evidenceScore: 0,
    };
    if (pending && !pending.forced) {
      // The slot has priority over an optional candidate already waiting in
      // the single queue. Optional evidence remains in its state file until
      // its TTL expires; it is not allowed to delay a mandatory window.
      this.proactiveBudgetStore.recordMetric("candidatesSuppressed");
      queueState = this.systemMessageQueueStore.replaceFirst(queueState, forcedMessage);
    } else {
      queueState = this.systemMessageQueueStore.enqueue(queueState, forcedMessage);
    }
    this.systemMessageQueueStore.save(queueState);
    console.log(`[cyberboss] mandatory ${due.id} due`);
    return { queued: true, slotId: due.id };
  }

  // Drains one queue item after the non-blocking host lock and atomic daily
  // budget gate. The observation bundle and fresh Clawd context are rebuilt
  // only after both gates pass.
  async runProactiveDrainTick() {
    const queueState = this.systemMessageQueueStore.load();
    if (!this.systemMessageQueueStore.hasPending(queueState)) {
      return { drained: false, reason: "empty" };
    }

    const allowedSenderId = this.senderGate.getAllowedSenderId();
    if (!allowedSenderId) {
      return { drained: false, reason: "no_allowed_sender" };
    }

    const first = this.systemMessageQueueStore.peek(queueState);
    const nowMs = Date.now();
    const createdAtMs = new Date(first.createdAt).getTime();
    if (!first.forced && Number.isFinite(createdAtMs) && nowMs - createdAtMs > this.config.proactiveEvidenceTtlMs) {
      this.systemMessageQueueStore.save(this.systemMessageQueueStore.takeFirst(queueState).state);
      this.proactiveBudgetStore.recordMetric("candidatesSuppressed");
      console.log(`[cyberboss] stale proactive candidate dropped source=${first.source}`);
      return { drained: true, results: [], reason: "stale" };
    }

    const forced = first.forced === true || first.source === "mandatory_slot";
    const eligibility = forced
      ? this.proactiveBudgetStore.load(nowMs)
      : this.proactiveBudgetStore.getOptionalEligibility(nowMs);
    const preflightEligibility = forced
      ? getForcedEligibility(eligibility, nowMs, this.proactiveBudgetStore)
      : eligibility;
    if (!preflightEligibility.allowed) {
      if (preflightEligibility.reason === "budget_exhausted" || preflightEligibility.reason === "mandatory_budget_reserved") {
        this.proactiveBudgetStore.recordMetric("budgetBlocked");
      }
      console.log(`[cyberboss] proactive ${forced ? "mandatory" : "optional"} blocked: ${preflightEligibility.reason}`);
      return { drained: false, reason: preflightEligibility.reason };
    }

    const lock = await tryAcquireHostLock({ lockDir: this.config.hostLockDir, kind: "proactive_turn" });
    if (!lock.acquired) {
      this.proactiveBudgetStore.recordMetric("lockBusy");
      console.log("[cyberboss] proactive lock busy");
      return { drained: false, reason: "lock_busy" };
    }

    let reservation = null;
    let runtimeStarted = false;
    try {
      const currentQueueState = this.systemMessageQueueStore.load();
      const message = this.systemMessageQueueStore.peek(currentQueueState);
      if (!message) return { drained: false, reason: "empty_after_lock" };

      reservation = this.proactiveBudgetStore.reserveCall({ forced, nowMs: Date.now() });
      if (!reservation.allowed) {
        if (reservation.reason === "budget_exhausted" || reservation.reason === "mandatory_budget_reserved") {
          this.proactiveBudgetStore.recordMetric("budgetBlocked");
        }
        return { drained: false, reason: reservation.reason };
      }

      const bundle = await this.observationBundleBuilder.build();
      const freshContext = await this.requestFreshProactiveContext();
      const prompt = require("./proactive-turn-builder").buildProactiveTurnPrompt(bundle, {
        freshContext,
        forced,
        candidate: message,
      });
      // Keep the candidate on disk until all pre-runtime preparation has
      // succeeded. If local preparation fails, the reservation is rolled
      // back and the candidate can be retried on the next pulse.
      this.systemMessageQueueStore.save(this.systemMessageQueueStore.takeFirst(currentQueueState).state);
      const result = await processProactiveMessage({ ...message, bundle, freshContext }, {
        prompt,
        callRuntime: (text) => {
          runtimeStarted = true;
          return this.runtimeAdapter.sendSingleTurn({
            text,
            resultSchema: forced ? MANDATORY_PROACTIVE_RESULT_JSON_SCHEMA : PROACTIVE_RESULT_JSON_SCHEMA,
          });
        },
        sendMessage: (text) => this.channelAdapter.sendText({ userId: allowedSenderId, text }).then(() => true).catch((error) => {
          console.error(`[cyberboss] proactive send failed: ${formatErrorMessage(error)}`);
          return false;
        }),
        markAgentMessageSent: (nowIso) => this.markAgentMessageSent(nowIso),
        onDeliveryFailed: (text) => {
          if (forced && message.slotId) this.proactiveBudgetStore.recordDeliveryFailure(message.slotId, text);
        },
        onLog: (msg) => console.log(`[cyberboss] ${msg}`),
      });

      if (result.sent) {
        if (forced && message.slotId) {
          this.proactiveBudgetStore.markSlotSatisfied(message.slotId);
        } else if (!forced) {
          this.proactiveBudgetStore.markOptionalMessageSent();
        }
      } else if (!forced && result.action === "silent") {
        this.proactiveBudgetStore.recordMetric("silentDecisions");
      }
      console.log(JSON.stringify({ mode: "proactive_turn", source: message.source, action: result.action, sent: result.sent }));
      return { drained: true, results: [result] };
    } catch (error) {
      if (reservation?.reserved && !runtimeStarted) {
        this.proactiveBudgetStore.releaseCallReservation(reservation);
      }
      throw error;
    } finally {
      await lock.release();
    }
  }

  async requestFreshProactiveContext() {
    try {
      const requestId = crypto.randomUUID();
      const context = await this.morrowContextRelay.requestContext({
        requestId,
        timeoutMs: this.config.contextSnapshotTimeoutMs,
      });
      if (context?.detail?.filtered) {
        this.proactiveBudgetStore.recordMetric("contextRefreshFiltered");
        console.log("[cyberboss] fresh context filtered");
      } else {
        this.proactiveBudgetStore.recordMetric("contextRefreshSuccess");
        console.log("[cyberboss] fresh context ok");
      }
      return context;
    } catch (error) {
      const message = formatErrorMessage(error);
      if (/timed out|timeout|abort/i.test(message)) {
        this.proactiveBudgetStore.recordMetric("contextRefreshTimeout");
        console.log("[cyberboss] fresh context timeout");
      } else {
        console.log(`[cyberboss] fresh context unavailable: ${message}`);
      }
      return { error: message };
    }
  }

  loadAllStoresOrExit() {
    try {
      this.currentStateStore.load();
      this.episodeStore.ensureCurrent(new Date().toISOString());
      this.memoryStore.load();
      this.intentionsStore.load();
      this.systemMessageQueueStore.load();
      this.eventOpportunityStateStore.load();
      this.proactiveBudgetStore.load();
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

function getForcedEligibility(state, nowMs, budgetStore) {
  if (state.totalCalls >= budgetStore.maxCallsPerDay) {
    return { allowed: false, reason: "budget_exhausted" };
  }
  if (state.lastCallAt) {
    const lastCallMs = new Date(state.lastCallAt).getTime();
    if (Number.isFinite(lastCallMs) && nowMs - lastCallMs < budgetStore.minCallGapMs) {
      return { allowed: false, reason: "call_gap" };
    }
  }
  return { allowed: true, reason: null };
}

module.exports = { CyberbossApp, buildIntentionMessageText };
