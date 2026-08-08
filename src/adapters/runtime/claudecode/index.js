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

// keke's own `claude` CLI usage rewrites (not edits) ~/.claude/.credentials.json
// on every OAuth refresh — a fresh inode that drops whatever ACL grant let
// cyberboss read the previous one. This fixed, argument-less, root-owned
// script re-applies exactly that one grant on exactly that one path; see
// /usr/local/sbin/cyberboss-ensure-claude-credential-acl and
// /etc/sudoers.d/cyberboss-claude-acl (only this exact invocation, no
// password, cyberboss -> keke). Run before every turn; fail closed if it
// doesn't succeed — never fall back to running claude without a fresh grant.
const ACL_PREFLIGHT_COMMAND = "/usr/bin/sudo";
const ACL_PREFLIGHT_ARGS = ["-n", "-u", "keke", "/usr/local/sbin/cyberboss-ensure-claude-credential-acl"];
const NOT_LOGGED_IN_PATTERN = /not logged in|please run \/login/i;

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

      await runAclPreflightOrThrow();

      try {
        return await attemptTurn({ text, config, systemPrompt, command });
      } catch (error) {
        if (!error.notLoggedIn) {
          throw error;
        }
        // Exactly one retry: the preflight above already ran this turn, so a
        // not-logged-in result means the grant it just applied still isn't
        // enough (e.g. a second refresh raced it) — try once more, then give
        // up rather than loop.
        console.error("[cyberboss] claude reported not-logged-in; retrying acl preflight once");
        await runAclPreflightOrThrow();
        return await attemptTurn({ text, config, systemPrompt, command });
      }
    },
  };
}

async function runAclPreflightOrThrow() {
  try {
    await runAclPreflight();
    console.log("[cyberboss] acl preflight ok");
  } catch (error) {
    console.error(`[cyberboss] acl preflight failed: ${error.message}`);
    throw new Error("acl preflight failed; refusing to start claude (fail closed)");
  }
}

function runAclPreflight() {
  return new Promise((resolve, reject) => {
    const child = spawn(ACL_PREFLIGHT_COMMAND, ACL_PREFLIGHT_ARGS, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`preflight script exited with code ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      resolve();
    });
  });
}

async function attemptTurn({ text, config, systemPrompt, command }) {
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
    }).catch((error) => {
      if (typeof error.stdout === "string" && NOT_LOGGED_IN_PATTERN.test(error.stdout)) {
        const wrapped = new Error("claude reported not-logged-in");
        wrapped.notLoggedIn = true;
        throw wrapped;
      }
      throw error;
    });
    const parsed = parseResult(raw);
    if (parsed.isError && NOT_LOGGED_IN_PATTERN.test(parsed.rawResultText)) {
      const wrapped = new Error("claude reported not-logged-in");
      wrapped.notLoggedIn = true;
      throw wrapped;
    }
    return parsed;
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
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
      // Explicit stdin: 'ignore' (closed immediately) instead of the 'pipe'
      // default — nothing ever writes to it, and left open the CLI stalls
      // every single turn for 3s waiting for stdin data before proceeding.
      stdio: ["ignore", "pipe", "pipe"],
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
        // Found live in session 3: a bare `claude exited with code 1` with
        // empty stderr is genuinely undiagnosable after the fact — stdout was
        // captured on the error object (for the not-logged-in retry check)
        // but never actually logged anywhere. Fixed by including a summary
        // in the message itself, deliberately excluding `result`/
        // `structured_output` (spec §7: never log message bodies) — only
        // envelope-level fields that can't contain conversation content.
        const error = new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}${summarizeStdoutForDiagnostics(stdout)}`);
        error.stdout = stdout;
        reject(error);
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

// Diagnostic-only summary of a failed process's stdout — deliberately never
// includes `result`/`structured_output` (the model's actual reply, spec §7:
// "日志不得记录正文"). If stdout parses as the CLI's own JSON envelope, only
// envelope-level fields that can't carry conversation content are surfaced;
// if it doesn't parse, only a byte length is reported (raw text could still
// be conversation content mid-stream, not just a CLI warning).
function summarizeStdoutForDiagnostics(stdout) {
  const text = String(stdout || "");
  if (!text) {
    return " [stdout: empty]";
  }
  try {
    const parsed = JSON.parse(text);
    const safeKeys = ["type", "subtype", "is_error", "stop_reason", "num_turns", "duration_ms", "total_cost_usd"];
    const safeFields = {};
    for (const key of safeKeys) {
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, key)) {
        safeFields[key] = parsed[key];
      }
    }
    return ` [stdout parsed, envelope fields: ${JSON.stringify(safeFields)}]`;
  } catch {
    return ` [stdout: ${Buffer.byteLength(text, "utf8")} bytes, not valid JSON]`;
  }
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

module.exports = { createClaudeCodeRuntimeAdapter, buildArgs, parseResult, RESULT_SCHEMA_JSON, runAclPreflightOrThrow, summarizeStdoutForDiagnostics };
