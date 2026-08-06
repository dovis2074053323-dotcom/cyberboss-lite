const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Session 1's runtime adapter only forwards `parsed.result` from `claude -p
// --output-format json` as plain WeChat text — it never passes a JSON Schema
// to the model (see src/adapters/runtime/claudecode/index.js buildArgs/parseResult).
// If the system prompt tells the model to emit schema-constrained JSON anyway,
// the model improvises a JSON object (e.g. {"message": "..."}) and that raw
// JSON string gets sent to the user verbatim instead of a normal reply.
const SYSTEM_PROMPT_PATH = path.resolve(__dirname, "..", "templates", "system-prompt.txt");

function readSystemPrompt() {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
}

test("system prompt does not instruct JSON Schema output while the runtime forwards plain text", () => {
  const prompt = readSystemPrompt();
  assert.doesNotMatch(prompt, /JSON\s*Schema/i);
  assert.doesNotMatch(prompt, /严格.{0,10}JSON/);
});

test("system prompt explicitly instructs plain-text-only replies", () => {
  const prompt = readSystemPrompt();
  assert.match(prompt, /纯文本/);
});

function looksLikeRawJsonReply(text) {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))
    && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

test("looksLikeRawJsonReply flags JSON-object replies and passes normal text", () => {
  assert.equal(looksLikeRawJsonReply('{"message":"突然发数字，啥意思"}'), true);
  assert.equal(looksLikeRawJsonReply("突然发数字，啥意思？"), false);
  assert.equal(looksLikeRawJsonReply("好的，收到～"), false);
});
