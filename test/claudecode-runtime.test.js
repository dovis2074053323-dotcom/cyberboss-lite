const test = require("node:test");
const assert = require("node:assert/strict");

const { buildArgs, parseResult, RESULT_SCHEMA_JSON, summarizeStdoutForDiagnostics } = require("../src/adapters/runtime/claudecode");

test("buildArgs always passes --json-schema with the result schema", () => {
  const args = buildArgs({ text: "hello", config: {}, systemPrompt: "sys" });
  const flagIndex = args.indexOf("--json-schema");
  assert.notEqual(flagIndex, -1, "--json-schema flag must be present");
  assert.equal(args[flagIndex + 1], RESULT_SCHEMA_JSON);
});

test("buildArgs uses resultSchema override instead of the normal-turn schema when given (task #14 proactive turns)", () => {
  const narrowSchema = { type: "object", properties: { action: { type: "string" } } };
  const args = buildArgs({ text: "hello", config: {}, systemPrompt: "sys", resultSchema: narrowSchema });
  const flagIndex = args.indexOf("--json-schema");
  assert.equal(args[flagIndex + 1], JSON.stringify(narrowSchema));
  assert.notEqual(args[flagIndex + 1], RESULT_SCHEMA_JSON);
});

test("buildArgs keeps the single-shot, no-tools, no-persistence flags", () => {
  const args = buildArgs({ text: "hello", config: {}, systemPrompt: "" });
  assert.ok(args.includes("--tools"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--safe-mode"));
});

test("parseResult reads structured_output, not a plain-text result string", () => {
  const raw = JSON.stringify({
    is_error: false,
    stop_reason: "tool_use",
    result: '{"reply":"hi","statePatch":{}}',
    structured_output: { reply: "hi", statePatch: {} },
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    duration_ms: 10,
    total_cost_usd: 0.001,
  });
  const parsed = parseResult(raw);
  assert.deepEqual(parsed.structuredResult, { reply: "hi", statePatch: {} });
  // Regression guard for the session-1 bug class: the adapter must never expose
  // a field that looks like "the text to send", only the structured object and
  // the raw diagnostic string kept clearly separate under a different name.
  assert.equal("replyText" in parsed, false);
  assert.equal(parsed.rawResultText, '{"reply":"hi","statePatch":{}}');
});

test("parseResult returns null structuredResult when the CLI didn't include one", () => {
  const raw = JSON.stringify({ is_error: false, result: "plain text, no schema call happened" });
  const parsed = parseResult(raw);
  assert.equal(parsed.structuredResult, null);
});

test("parseResult throws on non-JSON CLI output instead of guessing", () => {
  assert.throws(() => parseResult("not json"), /non-JSON output/);
});

// Found live in session 3: a bare "claude exited with code 1" with empty
// stderr was undiagnosable — stdout was captured on the error object but
// never actually surfaced anywhere. summarizeStdoutForDiagnostics fixes that
// while staying compliant with spec §7 ("日志不得记录正文") — it must never
// leak `result`/`structured_output`, only envelope-level fields.
test("summarizeStdoutForDiagnostics reports empty stdout explicitly", () => {
  assert.match(summarizeStdoutForDiagnostics(""), /empty/);
});

test("summarizeStdoutForDiagnostics on a parsed CLI envelope surfaces only safe fields, never result/structured_output", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    stop_reason: "tool_use",
    num_turns: 2,
    duration_ms: 500,
    total_cost_usd: 0.002,
    result: "这是一段真实的对话回复内容，绝不能出现在日志里",
    structured_output: { reply: "这是一段真实的对话回复内容，绝不能出现在日志里" },
  });
  const summary = summarizeStdoutForDiagnostics(stdout);
  assert.match(summary, /"is_error":true/);
  assert.match(summary, /"stop_reason":"tool_use"/);
  assert.doesNotMatch(summary, /真实的对话回复内容/, "绝不能把 result/structured_output 里的正文写进日志");
  // 用带冒号的 key 模式匹配，不是裸的 "result" 子串——type 字段的合法取值本身
  // 就是 "result"（CLI 顶层信封的消息类型），那不是内容泄漏。
  assert.doesNotMatch(summary, /"result":/, "summary 不应该包含 result 字段本身");
  assert.doesNotMatch(summary, /"structured_output":/, "summary 不应该包含 structured_output 字段本身");
});

test("summarizeStdoutForDiagnostics on non-JSON stdout only reports a byte length, never the raw text", () => {
  const stdout = "some raw CLI warning that happens to mention a secret token abc123";
  const summary = summarizeStdoutForDiagnostics(stdout);
  assert.match(summary, /bytes, not valid JSON/);
  assert.doesNotMatch(summary, /abc123/);
});
