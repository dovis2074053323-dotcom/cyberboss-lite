const test = require("node:test");
const assert = require("node:assert/strict");

const { buildArgs, parseResult, RESULT_SCHEMA_JSON } = require("../src/adapters/runtime/claudecode");

test("buildArgs always passes --json-schema with the result schema", () => {
  const args = buildArgs({ text: "hello", config: {}, systemPrompt: "sys" });
  const flagIndex = args.indexOf("--json-schema");
  assert.notEqual(flagIndex, -1, "--json-schema flag must be present");
  assert.equal(args[flagIndex + 1], RESULT_SCHEMA_JSON);
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
