const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { WeChatClaudeBot } = require("./bot");
const { readConfig } = require("./config");

function loadEnv(env = process.env) {
  const stateDir = typeof env.WECHAT_CLAUDE_STATE_DIR === "string" && env.WECHAT_CLAUDE_STATE_DIR.trim()
    ? env.WECHAT_CLAUDE_STATE_DIR.trim()
    : path.join(os.homedir(), ".wechat-claude-bot");
  const candidates = [path.join(process.cwd(), ".env"), path.join(stateDir, ".env")];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return envPath;
    }
  }
  dotenv.config();
  return "";
}

function printHelp() {
  console.log([
    "WeChat Claude bot",
    "",
    "Usage:",
    "  wechat-claude login    Scan a QR code to bind a WeChat account",
    "  wechat-claude start    Long-poll WeChat and reply with one Claude call per text",
    "  wechat-claude accounts List saved WeChat accounts",
    "  wechat-claude doctor   Print runtime configuration summary",
    "  wechat-claude help     Show this help",
  ].join("\n"));
}

function installRuntimeErrorHooks() {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[wechat-bot] unhandled rejection ${message}`);
  });
  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[wechat-bot] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main(argv = process.argv.slice(2)) {
  loadEnv();
  installRuntimeErrorHooks();
  const config = readConfig(argv);
  const command = config.mode;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const bot = new WeChatClaudeBot(config);
  if (command === "doctor") {
    console.log(JSON.stringify(bot.describe(), null, 2));
    return;
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  if (command === "login") {
    await bot.login();
    return;
  }
  if (command === "accounts") {
    bot.printAccounts();
    return;
  }
  if (command === "start") {
    const stop = () => bot.stop();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await bot.start();
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

module.exports = { loadEnv, main, printHelp };
