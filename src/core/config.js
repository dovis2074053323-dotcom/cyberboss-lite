const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot: readTextEnv("CYBERBOSS_WORKSPACE_ROOT") || stateDir,
    agentName: readTextEnv("CYBERBOSS_AGENT_NAME") || "Cyberboss",

    // Sender allowlist: fixed once set. Empty until bootstrap captures the first sender.
    allowedSenderId: readTextEnv("CYBERBOSS_ALLOWED_SENDER_ID"),
    senderAllowlistFile: path.join(stateDir, "sender-allowlist.json"),

    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    accountsDir: path.join(stateDir, "accounts"),
    syncBufferDir: path.join(stateDir, "sync-buffers"),

    // Single-flight turn timeout (spec 五: 180s hard cap). Bubble-merge timing
    // itself moved to inboundIdleDelayMs/inboundMaxWaitMs below (session 3).
    claudeTurnTimeoutMs: readIntEnv("CYBERBOSS_CLAUDE_TURN_TIMEOUT_MS") || 180_000,

    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    systemPromptFile: path.resolve(__dirname, "..", "..", "templates", "system-prompt.txt"),
    // Ephemeral per-turn CLAUDE_CONFIG_DIR home; only .credentials.json is symlinked in, deleted in finally.
    claudeConfigDirRoot: path.join(stateDir, "claude-cfg"),
    // Shared OAuth credential file this account only has read+traverse ACL on (see cc-connect-style symlink).
    // Must be set explicitly in production; no cross-user default is guessed here.
    sharedCredentialsFile: readTextEnv("CYBERBOSS_SHARED_CREDENTIALS_FILE"),

    // Session 2 (docs/session-2-spec.md §2): current state / open loops / long-term
    // memory / Future Intentions / episode storage, all atomic-write JSON under stateDir.
    currentStateFile: path.join(stateDir, "current-state.json"),
    memoriesFile: path.join(stateDir, "memories.json"),
    intentionsFile: path.join(stateDir, "intentions.json"),
    episodesDir: path.join(stateDir, "episodes"),
    episodeCurrentFile: path.join(stateDir, "episodes", "current.json"),
    episodeArchiveDir: path.join(stateDir, "episodes", "archive"),
    // spec §6: real proactive reminder/check_in sending stays off until session 3
    // wires the host-wide try-lock; resume_topic (no proactive send) can be live.
    enableScheduledIntentions: readBoolEnv("CYBERBOSS_ENABLE_SCHEDULED_INTENTIONS", false),

    // Session 3: shared cross-project /run/agent-runtime/claude.lock (protocol in
    // Morrow's docs/agent-runtime-lock.md). Overridable dir only so tests can point
    // at a tmpdir instead of the real tmpfs path.
    hostLockDir: readTextEnv("CYBERBOSS_HOST_LOCK_DIR") || "/run/agent-runtime",
    // Real WeChat turns may *wait* for the lock (Morrow is mid-turn) before
    // failing — no one is staring at a spinner the way Morrow's chat UI is, so
    // this is intentionally longer than Morrow's own 45s turn-lock wait.
    hostLockWaitMs: readIntEnv("CYBERBOSS_HOST_LOCK_WAIT_MS") || 60_000,

    // Bubble merge (spec 五), tuned in session 3: idle-debounce + hard cap
    // instead of a flat 10s wait. idleDelay resets on every new message in the
    // batch; maxWait is set once from the first message and never resets —
    // whichever fires first flushes. A lone message now merges in ~idleDelay,
    // not a flat 10s.
    inboundIdleDelayMs: readIntEnv("CYBERBOSS_INBOUND_IDLE_DELAY_MS") || 1_800,
    inboundMaxWaitMs: readIntEnv("CYBERBOSS_INBOUND_MAX_WAIT_MS") || 3_500,
  };
}

function readBoolEnv(name, defaultValue) {
  const value = readTextEnv(name);
  if (!value) {
    return defaultValue;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

module.exports = { readConfig };
