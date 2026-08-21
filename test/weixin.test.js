const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadWeixinAccount,
  saveWeixinAccount,
  resolveSelectedAccount,
} = require("../src/weixin/account-store");
const { getUpdates, sendText } = require("../src/weixin/api");
const { createInboundFilter, extractText } = require("../src/weixin/message-utils");
const { loadSyncBuffer, saveSyncBuffer } = require("../src/weixin/sync-buffer-store");

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-weixin-test-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    stateDir: root,
    accountsDir: path.join(root, "accounts"),
    syncBufferDir: path.join(root, "sync-buffers"),
    weixinBaseUrl: "https://example.test",
    accountId: "main",
    allowedSenderId: "sender",
    senderAllowlistFile: path.join(root, "sender-allowlist.json"),
  };
}

function textMessage(overrides = {}) {
  return {
    message_type: 1,
    from_user_id: "sender",
    context_token: "context-1",
    message_id: "message-1",
    item_list: [{ type: 1, text_item: { text: "hello" } }],
    ...overrides,
  };
}

test("inbound filter accepts only text and rejects bot/media/duplicates", () => {
  const filter = createInboundFilter();
  const config = tempConfig();
  assert.equal(extractText(textMessage().item_list), "hello");
  assert.equal(extractText([{ type: 2, image_item: {} }]), "");
  assert.equal(filter.normalize(textMessage(), config, "main").text, "hello");
  assert.equal(filter.normalize(textMessage(), config, "main"), null);
  assert.equal(filter.normalize(textMessage({ message_type: 2, message_id: "bot-1" }), config, "main"), null);
  assert.equal(filter.normalize(textMessage({ item_list: [{ type: 2, image_item: {} }], message_id: "image-1" }), config, "main"), null);
  assert.equal(filter.normalize(textMessage({ item_list: [{ type: 3, voice_item: { text: "hello" } }], message_id: "voice-1" }), config, "main"), null);
  assert.equal(filter.normalize(textMessage({ context_token: "" }), config, "main"), null);
});

test("account files and sync cursors are local durable state", () => {
  const config = tempConfig();
  const saved = saveWeixinAccount(config, "Main Account", {
    token: "bot-token",
    baseUrl: "https://wechat.test",
    userId: "owner",
  });
  assert.equal(saved.accountId, "main-account");
  assert.equal(loadWeixinAccount(config, "main-account").token, "bot-token");
  assert.equal(resolveSelectedAccount({ ...config, accountId: "main-account" }).userId, "owner");
  saveSyncBuffer(config, "main-account", "cursor-1");
  assert.equal(loadSyncBuffer(config, "main-account"), "cursor-1");
  assert.equal(fs.existsSync(path.join(config.stateDir, ["context", "-tokens.json"].join(""))), false);
});

test("WeChat API sends one text message with the inbound context token", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  test.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ ret: 0, get_updates_buf: "next", msgs: [] }), { status: 200 });
  };

  await getUpdates({
    baseUrl: "https://wechat.test",
    token: "bot-token",
    getUpdatesBuf: "old",
    timeoutMs: 10,
  });
  await sendText({
    baseUrl: "https://wechat.test",
    token: "bot-token",
    toUserId: "sender",
    text: "reply",
    contextToken: "context-1",
  });

  assert.equal(requests.length, 2);
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.msg.context_token, "context-1");
  assert.equal(body.msg.item_list.length, 1);
  assert.equal(body.msg.item_list[0].text_item.text, "reply");
  await assert.rejects(() => sendText({
    baseUrl: "https://wechat.test",
    token: "bot-token",
    toUserId: "sender",
    text: "reply",
    contextToken: "",
  }), /context_token/u);
});
