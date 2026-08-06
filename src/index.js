const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("./core/config");
const { CyberbossApp } = require("./core/app");

function ensureDefaultStateDirectory(config) {
  fs.mkdirSync(config.stateDir, { recursive: true });
}

function loadEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss"), ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }
  dotenv.config();
}

function printHelp() {
  console.log([
    "Cyberboss Lite — WeChat companion bridge",
    "",
    "Usage:",
    "  cyberboss login     Scan a QR code to bind a WeChat account",
    "  cyberboss start     Run the bridge loop (long-poll WeChat, single-turn Claude replies)",
    "  cyberboss doctor    Print current config/runtime status",
    "  cyberboss help      Show this help",
  ].join("\n"));
}

let runtimeErrorHooksInstalled = false;

function installRuntimeErrorHooks() {
  if (runtimeErrorHooksInstalled) {
    return;
  }
  runtimeErrorHooksInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[cyberboss] unhandled rejection ${message}`);
  });

  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[cyberboss] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  loadEnv();
  installRuntimeErrorHooks();
  const config = readConfig();
  ensureDefaultStateDirectory(config);
  const command = config.mode || "help";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const app = new CyberbossApp(config);

  if (command === "doctor") {
    app.printDoctor();
    return;
  }

  if (command === "login") {
    await app.login();
    return;
  }

  if (command === "accounts") {
    app.printAccounts();
    return;
  }

  if (command === "start") {
    await app.start();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = { main };
