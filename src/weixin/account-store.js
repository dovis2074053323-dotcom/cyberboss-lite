const fs = require("fs");
const path = require("path");

function normalizeAccountId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureAccountsDir(config) {
  fs.mkdirSync(config.accountsDir, { recursive: true });
}

function resolveAccountPath(config, accountId) {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    throw new Error("WeChat account id is empty");
  }
  return path.join(config.accountsDir, `${normalized}.json`);
}

function saveWeixinAccount(config, rawAccountId, update) {
  ensureAccountsDir(config);
  const accountId = normalizeAccountId(rawAccountId);
  if (!accountId) {
    throw new Error("Login returned an empty account id");
  }
  const existing = loadWeixinAccount(config, accountId) || {};
  const next = {
    accountId,
    rawAccountId: String(rawAccountId || "").trim() || existing.rawAccountId || "",
    token: nonEmpty(update?.token) || existing.token || "",
    baseUrl: nonEmpty(update?.baseUrl) || existing.baseUrl || config.weixinBaseUrl,
    userId: typeof update?.userId === "string" ? update.userId.trim() : existing.userId || "",
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(resolveAccountPath(config, accountId), JSON.stringify(next, null, 2), "utf8");
  try {
    fs.chmodSync(resolveAccountPath(config, accountId), 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return next;
}

function loadWeixinAccount(config, accountId) {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveAccountPath(config, normalized), "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      accountId: normalized,
      rawAccountId: typeof parsed.rawAccountId === "string" ? parsed.rawAccountId : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
      baseUrl: nonEmpty(parsed.baseUrl) || config.weixinBaseUrl,
      userId: typeof parsed.userId === "string" ? parsed.userId.trim() : "",
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}

function listWeixinAccounts(config) {
  ensureAccountsDir(config);
  return fs.readdirSync(config.accountsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => loadWeixinAccount(config, entry.name.slice(0, -5)))
    .filter(Boolean)
    .sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
}

function resolveSelectedAccount(config) {
  if (config.accountId) {
    const account = loadWeixinAccount(config, config.accountId);
    if (!account) {
      throw new Error(`WeChat account not found: ${config.accountId}`);
    }
    return assertUsableAccount(account);
  }

  const accounts = listWeixinAccounts(config);
  if (!accounts.length) {
    throw new Error("No saved WeChat account was found. Run `wechat-claude login` first.");
  }
  if (accounts.length > 1) {
    throw new Error(`Multiple WeChat accounts were found. Set WECHAT_CLAUDE_ACCOUNT_ID: ${accounts.map((item) => item.accountId).join(", ")}`);
  }
  return assertUsableAccount(accounts[0]);
}

function assertUsableAccount(account) {
  if (!account.token) {
    throw new Error(`WeChat account is missing a token: ${account.accountId}. Run login again.`);
  }
  return account;
}

function deleteWeixinAccount(config, accountId) {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return false;
  }
  try {
    fs.unlinkSync(resolveAccountPath(config, normalized));
    return true;
  } catch (error) {
    return error && error.code === "ENOENT" ? false : false;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  deleteWeixinAccount,
  listWeixinAccounts,
  loadWeixinAccount,
  normalizeAccountId,
  resolveAccountPath,
  resolveSelectedAccount,
  saveWeixinAccount,
};
