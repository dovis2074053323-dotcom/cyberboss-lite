const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { RESULT_JSON_SCHEMA } = require("../../../core/result-schema");

// Single-shot runtime: every turn is a fresh `claude -p` process with no tools, no
// MCP, no slash commands, no session persistence, and no CLAUDE.md/settings discovery.
// There is no resumable thread — relationship continuity is Cyberboss's own job
// (episode/memory/intentions, session 2), not Claude Code's.
//
// Structured output (session 2, spec §3): the installed CLI (verified against
// 2.1.223) takes `--json-schema <json>` and returns the parsed object under
// `structured_output` in the --output-format json envelope — `result` is only
// that same object re-serialized to a string. We read `structured_output`
// directly and never assume the old plain-text-in-`result` shape. There is no
// `--max-turns` flag on this CLI; "one call per merged turn" is enforced by
// spawning exactly one `claude` process per flushed batch, not by a CLI flag —
// the CLI's own `num_turns` in the response reflects its internal structured-
// output validation round-trip (observed as 2 even for a single logical call)
// and is not meaningful here.
const RESULT_SCHEMA_JSON = JSON.stringify(RESULT_JSON_SCHEMA);

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
    "--json-schema", RESULT_SCHEMA_JSON,
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
  // `structured_output` is the CLI's already-parsed object for --json-schema
  // calls; `result` is the same content re-serialized to a string and is only
  // kept here for diagnostics — the coordinator must not treat it as a reply.
  const structuredResult = (parsed.structured_output && typeof parsed.structured_output === "object")
    ? parsed.structured_output
    : null;
  return {
    structuredResult,
    rawResultText: typeof parsed.result === "string" ? parsed.result : "",
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

module.exports = { createClaudeCodeRuntimeAdapter, buildArgs, parseResult, RESULT_SCHEMA_JSON };
