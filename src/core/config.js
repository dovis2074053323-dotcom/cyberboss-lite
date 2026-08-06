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

    // 10s bubble-merge window (spec 五) and single-flight turn timeout (spec 五: 180s hard cap).
    inboundMergeWindowMs: readIntEnv("CYBERBOSS_INBOUND_MERGE_WINDOW_MS") || 10_000,
    claudeTurnTimeoutMs: readIntEnv("CYBERBOSS_CLAUDE_TURN_TIMEOUT_MS") || 180_000,

    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    systemPromptFile: path.resolve(__dirname, "..", "..", "templates", "system-prompt.txt"),
    // Ephemeral per-turn CLAUDE_CONFIG_DIR home; only .credentials.json is symlinked in, deleted in finally.
    claudeConfigDirRoot: path.join(stateDir, "claude-cfg"),
    // Shared OAuth credential file this account only has read+traverse ACL on (see cc-connect-style symlink).
    // Must be set explicitly in production; no cross-user default is guessed here.
    sharedCredentialsFile: readTextEnv("CYBERBOSS_SHARED_CREDENTIALS_FILE"),
  };
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
