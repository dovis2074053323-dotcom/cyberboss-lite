const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ACL_SUDO = "/usr/bin/sudo";
const CREDENTIALS_BASENAME = ".credentials.json";
const ALLOWED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ"];

function createClaudeRunner(config, deps = {}) {
  const command = config.claudeCommand || "claude";
  const runProcess = deps.runProcess || runClaudeProcess;
  const runAcl = deps.runAcl || (() => runCredentialAcl(config));

  return {
    describe() {
      return { id: "claude", command };
    },

    async run(text) {
      const prompt = normalizeText(text);
      if (!prompt) {
        throw new Error("Claude prompt must be non-empty");
      }
      if (!config.skipCredentialAcl) {
        await runAcl();
      }
      return attemptTurn({ config, command, prompt, runProcess });
    },
  };
}

async function attemptTurn({ config, command, prompt, runProcess }) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  fs.mkdirSync(config.claudeConfigDirRoot, { recursive: true });
  const configDir = fs.mkdtempSync(path.join(config.claudeConfigDirRoot, "turn-"));
  try {
    fs.symlinkSync(config.sharedCredentialsFile, path.join(configDir, CREDENTIALS_BASENAME));
    const raw = await runProcess({
      command,
      args: buildArgs(prompt),
      env: buildEnv({ configDir, sourceEnv: process.env }),
      cwd: config.runtimeDir,
      timeoutMs: config.claudeTurnTimeoutMs,
    });
    return parseResult(raw);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function buildArgs(text) {
  return [
    "-p",
    String(text),
    "--safe-mode",
    "--tools",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
}

function buildEnv({ configDir, sourceEnv = process.env, home = os.homedir() }) {
  const env = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }
  env.HOME = home;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function parseResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error("Claude returned non-JSON output");
  }
  if (!parsed || typeof parsed !== "object" || parsed.is_error !== false) {
    throw new Error("Claude returned an error result");
  }
  if (typeof parsed.result !== "string" || !parsed.result.trim()) {
    throw new Error("Claude returned an empty result");
  }
  return {
    result: parsed.result,
    usage: {
      input_tokens: numberOrZero(parsed.usage?.input_tokens),
      output_tokens: numberOrZero(parsed.usage?.output_tokens),
      cache_read_input_tokens: numberOrZero(parsed.usage?.cache_read_input_tokens),
      cache_creation_input_tokens: numberOrZero(parsed.usage?.cache_creation_input_tokens),
      duration_ms: numberOrZero(parsed.duration_ms),
    },
  };
}

function runCredentialAcl(config) {
  const sudo = config.credentialAclSudo || ACL_SUDO;
  const helper = config.credentialAclHelper;
  if (!helper) {
    throw new Error("credential ACL helper is not configured");
  }
  return runHelper(sudo, ["-n", "-u", "keke", helper]);
}

function runHelper(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(new Error(`credential ACL helper could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`credential ACL helper exited with code ${code}: ${stderr.trim().slice(0, 240)}`));
        return;
      }
      resolve();
    });
  });
}

function runClaudeProcess({ command, args, env, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new Error(`Claude process timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const error = new Error(`Claude exited with code ${code}`);
        error.stdout = stdout;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ALLOWED_ENV_KEYS,
  buildArgs,
  buildEnv,
  createClaudeRunner,
  parseResult,
  runClaudeProcess,
  runCredentialAcl,
};
