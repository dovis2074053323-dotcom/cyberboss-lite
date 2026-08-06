const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Session 1 shipped a runtime that only forwarded plain text but a system
// prompt that asked for JSON — the mismatch made the model improvise raw JSON
// text straight to WeChat. Session 2 wires real --json-schema structured
// output (src/adapters/runtime/claudecode/index.js), so the system prompt must
// now go back to requesting schema-following output — and this file's own
// assertions invert with it. See docs/session-2-spec.md §3: "不得出现
// 'prompt 要求 JSON、runtime 却未传 schema' 的旧问题".
const SYSTEM_PROMPT_PATH = path.resolve(__dirname, "..", "templates", "system-prompt.txt");
const RUNTIME_ADAPTER_PATH = path.resolve(__dirname, "..", "src", "adapters", "runtime", "claudecode", "index.js");

function readSystemPrompt() {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
}

test("system prompt instructs schema-following, no Markdown/explanation output", () => {
  const prompt = readSystemPrompt();
  assert.match(prompt, /JSON\s*Schema/i);
  assert.match(prompt, /严格.{0,10}JSON/);
});

test("runtime adapter actually passes --json-schema (prompt/runtime can't drift apart again)", () => {
  const adapterSource = fs.readFileSync(RUNTIME_ADAPTER_PATH, "utf8");
  assert.match(adapterSource, /--json-schema/);
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
