const qrcodeTerminal = require("qrcode-terminal");

const {
  deleteWeixinAccount,
  listWeixinAccounts,
  saveWeixinAccount,
} = require("./account-store");

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;

async function runLoginFlow(config) {
  console.log("[wechat-bot] starting WeChat QR login...");
  const result = await waitForLogin({
    apiBaseUrl: config.weixinBaseUrl,
    botType: config.weixinQrBotType,
    timeoutMs: 480_000,
  });
  const account = saveWeixinAccount(config, result.accountId, result);
  removeStaleAccounts(config, account);
  console.log("\nConnected to WeChat successfully.");
  console.log(`accountId: ${account.accountId}`);
  console.log(`userId: ${account.userId || "(unknown)"}`);
  console.log(`baseUrl: ${account.baseUrl}`);
}

async function waitForLogin({ apiBaseUrl, botType, timeoutMs }) {
  let qrResponse = await fetchQrCode(apiBaseUrl, botType);
  let startedAt = Date.now();
  let refreshCount = 1;
  let scannedPrinted = false;

  console.log("Scan this QR code with WeChat:\n");
  printQrCode(qrResponse.qrcode_img_content);
  console.log("\nWaiting for the connection result...\n");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Date.now() - startedAt > ACTIVE_LOGIN_TTL_MS) {
      ({ qrResponse, startedAt, refreshCount } = await refreshQrCode({
        apiBaseUrl,
        botType,
        refreshCount,
      }));
      scannedPrinted = false;
    }

    const statusResponse = await pollQrStatus(apiBaseUrl, qrResponse.qrcode);
    switch (statusResponse.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("\nQR code scanned. Confirm the login in WeChat...\n");
          scannedPrinted = true;
        }
        break;
      case "expired":
        ({ qrResponse, startedAt, refreshCount } = await refreshQrCode({
          apiBaseUrl,
          botType,
          refreshCount,
        }));
        scannedPrinted = false;
        break;
      case "confirmed":
        if (!statusResponse.bot_token || !statusResponse.ilink_bot_id) {
          throw new Error("WeChat login response was missing the account id or token");
        }
        return {
          accountId: statusResponse.ilink_bot_id,
          token: statusResponse.bot_token,
          baseUrl: statusResponse.baseurl || apiBaseUrl,
          userId: statusResponse.ilink_user_id || "",
        };
      default:
        break;
    }
  }
  throw new Error("WeChat login timed out. Run login again.");
}

async function refreshQrCode({ apiBaseUrl, botType, refreshCount }) {
  const nextRefreshCount = refreshCount + 1;
  if (nextRefreshCount > MAX_QR_REFRESH_COUNT) {
    throw new Error("The WeChat QR code expired too many times. Run login again.");
  }
  const qrResponse = await fetchQrCode(apiBaseUrl, botType);
  console.log(`QR code expired. Refreshing... (${nextRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
  printQrCode(qrResponse.qrcode_img_content);
  return { qrResponse, startedAt: Date.now(), refreshCount: nextRefreshCount };
}

async function fetchQrCode(apiBaseUrl, botType) {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    ensureTrailingSlash(apiBaseUrl),
  );
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WeChat QR request failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function pollQrStatus(apiBaseUrl, qrcode) {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    ensureTrailingSlash(apiBaseUrl),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`WeChat QR status request failed with HTTP ${response.status}`);
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function printQrCode(url) {
  try {
    qrcodeTerminal.generate(url, { small: true });
    console.log("If the QR code does not render correctly, open this link in a browser:");
    console.log(url);
  } catch {
    console.log(url);
  }
}

function removeStaleAccounts(config, activeAccount) {
  const activeUserId = normalizeText(activeAccount?.userId);
  if (!activeUserId) {
    return;
  }
  for (const account of listWeixinAccounts(config)) {
    if (account.accountId !== activeAccount.accountId && normalizeText(account.userId) === activeUserId) {
      deleteWeixinAccount(config, account.accountId);
    }
  }
}

function ensureTrailingSlash(url) {
  return String(url).endsWith("/") ? String(url) : `${url}/`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { runLoginFlow, waitForLogin };
