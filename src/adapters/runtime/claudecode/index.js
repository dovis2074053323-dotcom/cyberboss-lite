const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

// Single-shot runtime: every turn is a fresh `claude -p` process with no tools, no
// MCP, no slash commands, no session persistence, and no CLAUDE.md/settings discovery.
// There is no resumable thread — relationship continuity is Cyberboss's own job
// (episode/memory, added in a later session), not Claude Code's.
function createClaudeCodeRuntimeAdapter(config) {
  const command = config.claudeCommand || "claude";
  const systemPrompt = loadSystemPrompt(config);

  return {
    describe() {
      return {
        id: "claudecode",
        kind: "runtime",
        command,
        model: config.claudeModel || "(default)",
      };
    },

    async sendSingleTurn({ text }) {
      if (!normalizeText(config.sharedCredentialsFile)) {
        throw new Error("CYBERBOSS_SHARED_CREDENTIALS_FILE is not configured");
      }
      fs.mkdirSync(config.claudeConfigDirRoot, { recursive: true });
      const configDir = fs.mkdtempSync(path.join(config.claudeConfigDirRoot, "cfg-"));
      try {
        fs.symlinkSync(config.sharedCredentialsFile, path.join(configDir, ".credentials.json"));
        const args = buildArgs({ text, config, systemPrompt });
        const env = buildEnv({ configDir });
        const raw = await runClaudeProcess({
          command,
          args,
          env,
          cwd: config.workspaceRoot,
          timeoutMs: config.claudeTurnTimeoutMs,
        });
        return parseResult(raw);
      } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    },
  };
}

function buildArgs({ text, config, systemPrompt }) {
  const args = [
    "-p", text,
    "--safe-mode",
    "--tools", "",
    "--no-session-persistence",
    "--output-format", "json",
  ];
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  if (normalizeText(config.claudeModel)) {
    args.push("--model", config.claudeModel);
  }
  return args;
}

function buildEnv({ configDir }) {
  const allowedKeys = ["PATH", "LANG", "LC_ALL", "TZ"];
  const env = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  env.HOME = os.homedir();
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  return env;
}

function runClaudeProcess({ command, args, env, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new Error(`claude process timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`claude returned non-JSON output: ${String(error.message || error)}`);
  }
  return {
    replyText: typeof parsed.result === "string" ? parsed.result : "",
    isError: Boolean(parsed.is_error),
    stopReason: parsed.stop_reason || "",
    usage: {
      inputTokens: parsed.usage?.input_tokens || 0,
      outputTokens: parsed.usage?.output_tokens || 0,
      cacheReadTokens: parsed.usage?.cache_read_input_tokens || 0,
      cacheCreationTokens: parsed.usage?.cache_creation_input_tokens || 0,
      durationMs: parsed.duration_ms || 0,
      costUsd: parsed.total_cost_usd || 0,
    },
  };
}

function loadSystemPrompt(config) {
  try {
    const template = fs.readFileSync(config.systemPromptFile, "utf8");
    return template.replace(/\{\{agent_name\}\}/g, config.agentName || "Cyberboss").trim();
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { createClaudeCodeRuntimeAdapter };
