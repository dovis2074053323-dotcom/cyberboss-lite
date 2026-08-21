const os = require("os");
const path = require("path");

function readConfig(argv = process.argv.slice(2), env = process.env) {
  const args = Array.isArray(argv) ? argv : [];
  const mode = args[0] || "help";
  const stateDir = readTextEnv(env.WECHAT_CLAUDE_STATE_DIR) || path.join(os.homedir(), ".wechat-claude-bot");
  const runtimeDir = readTextEnv(env.WECHAT_CLAUDE_RUNTIME_DIR) || path.join(stateDir, "runtime");
  const claudeConfigDirRoot = readTextEnv(env.WECHAT_CLAUDE_CONFIG_DIR_ROOT)
    || path.join(stateDir, "claude-cfg");

  return {
    mode,
    argv: args,
    stateDir,
    runtimeDir,
    claudeConfigDirRoot,
    senderAllowlistFile: path.join(stateDir, "sender-allowlist.json"),
    allowedSenderId: readTextEnv(env.WECHAT_CLAUDE_ALLOWED_SENDER_ID),
    accountId: readTextEnv(env.WECHAT_CLAUDE_ACCOUNT_ID),
    accountsDir: path.join(stateDir, "accounts"),
    syncBufferDir: path.join(stateDir, "sync-buffers"),

    weixinBaseUrl: readTextEnv(env.WECHAT_CLAUDE_WEIXIN_BASE_URL)
      || "https://ilinkai.weixin.qq.com",
    weixinQrBotType: readTextEnv(env.WECHAT_CLAUDE_WEIXIN_QR_BOT_TYPE) || "3",
    longPollTimeoutMs: readIntEnv(env.WECHAT_CLAUDE_LONG_POLL_TIMEOUT_MS) || 35_000,

    claudeCommand: readTextEnv(env.WECHAT_CLAUDE_COMMAND) || "claude",
    claudeTurnTimeoutMs: readIntEnv(env.WECHAT_CLAUDE_TURN_TIMEOUT_MS) || 180_000,
    sharedCredentialsFile: readTextEnv(env.WECHAT_CLAUDE_SHARED_CREDENTIALS_FILE)
      || "/home/keke/.claude/.credentials.json",
    credentialAclHelper: readTextEnv(env.WECHAT_CLAUDE_CREDENTIAL_ACL_HELPER)
      || "/usr/local/sbin/wechat-claude-ensure-credential-acl",
    credentialAclSudo: readTextEnv(env.WECHAT_CLAUDE_SUDO) || "/usr/bin/sudo",

    hostLockDir: readTextEnv(env.WECHAT_CLAUDE_HOST_LOCK_DIR) || "/run/agent-runtime",
    hostLockWaitMs: readIntEnv(env.WECHAT_CLAUDE_HOST_LOCK_WAIT_MS) || 60_000,
  };
}

function readTextEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readIntEnv(value) {
  const text = readTextEnv(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

module.exports = { readConfig };
