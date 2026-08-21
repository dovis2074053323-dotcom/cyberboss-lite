const { createClaudeRunner } = require("./claude");
const { acquireHostLock } = require("./host-lock");
const { createSenderGate } = require("./sender-gate");
const {
  listWeixinAccounts,
  resolveSelectedAccount,
} = require("./weixin/account-store");
const { getUpdates, sendText } = require("./weixin/api");
const { runLoginFlow } = require("./weixin/login");
const { createInboundFilter } = require("./weixin/message-utils");
const { loadSyncBuffer, saveSyncBuffer } = require("./weixin/sync-buffer-store");

const RETRY_DELAY_MS = 2_000;

class WeChatClaudeBot {
  constructor(config, deps = {}) {
    this.config = config;
    this.channel = deps.channel || createWeixinChannel(config);
    this.claude = deps.claude || createClaudeRunner(config);
    this.senderGate = deps.senderGate || createSenderGate(config);
    this.acquireHostLock = deps.acquireHostLock || acquireHostLock;
    this.inboundFilter = deps.inboundFilter || createInboundFilter();
    this.queue = [];
    this.draining = false;
    this.started = false;
    this.stopped = false;
    this.idleWaiters = [];
  }

  describe() {
    return {
      stateDir: this.config.stateDir,
      runtimeDir: this.config.runtimeDir,
      channel: this.channel.describe(),
      claude: this.claude.describe(),
      allowedSenderId: this.senderGate.getAllowedSenderId() || "(bootstrap: not captured)",
    };
  }

  async login() {
    await runLoginFlow(this.config);
  }

  printAccounts() {
    const accounts = listWeixinAccounts(this.config);
    if (!accounts.length) {
      console.log("No saved WeChat account found. Run `wechat-claude login` first.");
      return;
    }
    console.log("Saved WeChat accounts:");
    for (const account of accounts) {
      console.log(`- ${account.accountId}`);
      console.log(`  userId: ${account.userId || "(unknown)"}`);
      console.log(`  baseUrl: ${account.baseUrl || this.config.weixinBaseUrl}`);
      console.log(`  savedAt: ${account.savedAt || "(unknown)"}`);
    }
  }

  async start() {
    const account = this.channel.resolveAccount();
    let syncBuffer = loadSyncBuffer(this.config, account.accountId);
    this.started = true;
    this.stopped = false;
    console.log("[wechat-bot] bridge loop started; waiting for WeChat messages.");

    try {
      while (!this.stopped) {
        try {
          const response = await this.channel.getUpdates({
            syncBuffer,
            timeoutMs: this.config.longPollTimeoutMs,
          });
          const nextBuffer = typeof response?.get_updates_buf === "string"
            ? response.get_updates_buf.trim()
            : "";
          if (nextBuffer && nextBuffer !== syncBuffer) {
            syncBuffer = nextBuffer;
            saveSyncBuffer(this.config, account.accountId, syncBuffer);
          }
          for (const message of Array.isArray(response?.msgs) ? response.msgs : []) {
            this.handleIncomingMessage(message);
          }
        } catch (error) {
          if (this.stopped) {
            break;
          }
          console.error(`[wechat-bot] long-poll failed: ${safeErrorMessage(error)}`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    } finally {
      this.started = false;
      this.stopped = true;
      await this.waitForIdle();
    }
  }

  stop() {
    this.stopped = true;
  }

  handleIncomingMessage(message) {
    const account = this.channel.resolveAccount();
    const normalized = this.inboundFilter.normalize(message, this.config, account.accountId);
    if (!normalized) {
      return false;
    }

    const gateResult = this.senderGate.evaluate(normalized.senderId);
    if (gateResult === "rejected") {
      console.warn(`[wechat-bot] sender rejected id=${redactId(normalized.senderId)}`);
      return false;
    }
    if (gateResult === "bootstrap_captured") {
      console.log(`[wechat-bot] sender allowlist captured id=${redactId(normalized.senderId)}`);
      return false;
    }

    this.queue.push(normalized);
    void this.drainQueue();
    return true;
  }

  async waitForIdle() {
    if (!this.draining && this.queue.length === 0) {
      return;
    }
    await new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async drainQueue() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length) {
        const message = this.queue.shift();
        await this.processMessage(message);
      }
    } finally {
      this.draining = false;
      if (!this.queue.length) {
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) {
          resolve();
        }
      } else {
        void this.drainQueue();
      }
    }
  }

  async processMessage(message) {
    let lock = null;
    try {
      lock = await this.acquireHostLock({
        lockDir: this.config.hostLockDir,
        kind: "wechat_turn",
        timeoutMs: this.config.hostLockWaitMs,
      });
      const result = await this.claude.run(message.text);
      await this.channel.sendText({
        userId: message.senderId,
        text: result.result,
        contextToken: message.contextToken,
      });
      console.log(JSON.stringify({
        mode: "reply",
        usage: result.usage,
      }));
    } catch (error) {
      console.error(`[wechat-bot] message failed: ${safeErrorMessage(error)}`);
    } finally {
      if (lock) {
        await lock.release().catch((error) => {
          console.error(`[wechat-bot] host lock release failed: ${safeErrorMessage(error)}`);
        });
      }
    }
  }
}

function createWeixinChannel(config) {
  let account = null;
  const ensureAccount = () => {
    if (!account) {
      account = resolveSelectedAccount(config);
    }
    return account;
  };

  return {
    describe() {
      return {
        id: "weixin",
        accountsDir: config.accountsDir,
        syncBufferDir: config.syncBufferDir,
        baseUrl: config.weixinBaseUrl,
      };
    },
    resolveAccount: ensureAccount,
    async getUpdates({ syncBuffer, timeoutMs }) {
      const selected = ensureAccount();
      return getUpdates({
        baseUrl: selected.baseUrl,
        token: selected.token,
        getUpdatesBuf: syncBuffer,
        timeoutMs,
      });
    },
    async sendText({ userId, text, contextToken }) {
      const selected = ensureAccount();
      return sendText({
        baseUrl: selected.baseUrl,
        token: selected.token,
        toUserId: userId,
        text,
        contextToken,
      });
    },
  };
}

function redactId(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= 8) {
    return "<id>";
  }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { WeChatClaudeBot, createWeixinChannel, safeErrorMessage };
