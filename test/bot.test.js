const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { WeChatClaudeBot } = require("../src/bot");
const { acquireHostLock, HostLockBusyError } = require("../src/host-lock");

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bot-test-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    stateDir: root,
    runtimeDir: path.join(root, "runtime"),
    claudeConfigDirRoot: path.join(root, "claude-cfg"),
    accountsDir: path.join(root, "accounts"),
    syncBufferDir: path.join(root, "sync-buffers"),
    senderAllowlistFile: path.join(root, "sender-allowlist.json"),
    allowedSenderId: "sender",
    accountId: "main",
    hostLockDir: path.join(root, "host-lock"),
    hostLockWaitMs: 2_000,
    longPollTimeoutMs: 10,
  };
}

function makeChannel(sent) {
  return {
    describe: () => ({ id: "test-weixin" }),
    resolveAccount: () => ({ accountId: "main" }),
    sendText: async (message) => { sent.push(message); },
  };
}

function message(id, text, contextToken = `context-${id}`, sender = "sender") {
  return {
    message_type: 1,
    from_user_id: sender,
    context_token: contextToken,
    message_id: id,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

test("one admitted text message produces exactly one Claude call and one reply", async () => {
  const config = tempConfig();
  const sent = [];
  const calls = [];
  let lockCount = 0;
  const bot = new WeChatClaudeBot(config, {
    channel: makeChannel(sent),
    claude: {
      describe: () => ({ id: "fake-claude" }),
      run: async (text) => {
        calls.push(text);
        return { result: `answer:${text}`, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
    acquireHostLock: async () => {
      lockCount += 1;
      return { release: async () => {} };
    },
  });

  assert.equal(bot.handleIncomingMessage(message("one", "hello")), true);
  await bot.waitForIdle();
  assert.deepEqual(calls, ["hello"]);
  assert.equal(lockCount, 1);
  assert.deepEqual(sent, [{
    userId: "sender",
    text: "answer:hello",
    contextToken: "context-one",
  }]);
});

test("two rapid messages stay separate and drain in FIFO order", async () => {
  const config = tempConfig();
  const sent = [];
  const calls = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const bot = new WeChatClaudeBot(config, {
    channel: makeChannel(sent),
    claude: {
      describe: () => ({ id: "fake-claude" }),
      run: async (text) => {
        calls.push(text);
        if (text === "first") {
          await firstStarted;
        }
        return { result: `reply:${text}`, usage: {} };
      },
    },
    acquireHostLock: async () => ({ release: async () => {} }),
  });

  bot.handleIncomingMessage(message("first", "first"));
  await new Promise((resolve) => setImmediate(resolve));
  bot.handleIncomingMessage(message("second", "second"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first"]);
  releaseFirst();
  await bot.waitForIdle();
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(sent.map((item) => [item.text, item.contextToken]), [
    ["reply:first", "context-first"],
    ["reply:second", "context-second"],
  ]);
});

test("bot messages, other senders, duplicate messages, and media cause zero extra calls", async () => {
  const config = tempConfig();
  const sent = [];
  const calls = [];
  const bot = new WeChatClaudeBot(config, {
    channel: makeChannel(sent),
    claude: {
      describe: () => ({ id: "fake-claude" }),
      run: async (text) => {
        calls.push(text);
        return { result: "ok", usage: {} };
      },
    },
    acquireHostLock: async () => ({ release: async () => {} }),
  });

  assert.equal(bot.handleIncomingMessage({
    ...message("bot", "ignored", "context-bot", "sender"),
    message_type: 2,
  }), false);
  assert.equal(bot.handleIncomingMessage(message("other", "ignored", "context-other", "other")), false);
  assert.equal(bot.handleIncomingMessage({
    ...message("image", ""),
    item_list: [{ type: 2, image_item: { media: {} } }],
  }), false);
  const admitted = message("real", "real");
  assert.equal(bot.handleIncomingMessage(admitted), true);
  assert.equal(bot.handleIncomingMessage(admitted), false);
  await bot.waitForIdle();
  assert.deepEqual(calls, ["real"]);
  assert.equal(sent.length, 1);
});

test("shared host lock blocks a second Claude consumer", async () => {
  const config = tempConfig();
  const first = await acquireHostLock({ lockDir: config.hostLockDir, kind: "first", timeoutMs: 100 });
  await assert.rejects(
    () => acquireHostLock({ lockDir: config.hostLockDir, kind: "second", timeoutMs: 100 }),
    HostLockBusyError,
  );
  await first.release();
  const second = await acquireHostLock({ lockDir: config.hostLockDir, kind: "second", timeoutMs: 100 });
  await second.release();
});
