const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { redactSensitiveText } = require("./redact");

const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BODY_BYTES = 64 << 20;
const CHANNEL_VERSION = readChannelVersion();

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

async function getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS }) {
  const body = JSON.stringify({
    get_updates_buf: getUpdatesBuf,
    base_info: buildBaseInfo(),
  });
  try {
    return await postJson({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      token,
      body,
      timeoutMs,
      label: "getUpdates",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  }
}

async function sendText({ baseUrl, token, toUserId, text, contextToken, clientId }) {
  const normalizedContextToken = normalizeText(contextToken);
  const normalizedText = typeof text === "string" ? text : String(text || "");
  if (!normalizedContextToken) {
    throw new Error("WeChat sendText requires the inbound context_token");
  }
  if (!normalizedText.trim()) {
    throw new Error("WeChat sendText requires non-empty text");
  }

  return postJson({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId || `wc-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: normalizedText } }],
        context_token: normalizedContextToken,
      },
      base_info: buildBaseInfo(),
    }),
    label: "sendText",
  });
}

async function postJson({ baseUrl, endpoint, token, body, timeoutMs, label }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_API_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout + 5_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BODY_BYTES) {
      throw new Error(`${label} response is too large`);
    }
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }
    const parsed = parseJson(raw, label);
    const ret = parsed?.ret;
    const errcode = parsed?.errcode;
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      const error = new Error(`${label} returned an error`);
      error.code = ret ?? errcode;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError" && error.code !== undefined) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error && /^https?:/i.test(error.message)) {
      throw new Error(`${label} request failed`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function buildHeaders(token, body) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  const normalizedToken = normalizeText(token);
  if (normalizedToken) {
    headers.Authorization = `Bearer ${normalizedToken}`;
  }
  return headers;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function ensureTrailingSlash(url) {
  return String(url).endsWith("/") ? String(url) : `${url}/`;
}

function readChannelVersion() {
  try {
    const packagePath = path.resolve(__dirname, "../../package.json");
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { buildBaseInfo, getUpdates, sendText };
