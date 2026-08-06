// Spec §4 condition B: a fixed, testable, conservative estimate — no tokenizer
// dependency. 1 estimated token per 3 UTF-8 bytes, rounded up.
function estimateTokens(text) {
  const byteLength = Buffer.byteLength(String(text || ""), "utf8");
  return Math.ceil(byteLength / 3);
}

const EPISODE_SOFT_TOKEN_LIMIT = 3500;
const EPISODE_HARD_TOKEN_LIMIT = 5000;
const MEMORY_INJECTION_TOKEN_BUDGET = 900;

module.exports = {
  estimateTokens,
  EPISODE_SOFT_TOKEN_LIMIT,
  EPISODE_HARD_TOKEN_LIMIT,
  MEMORY_INJECTION_TOKEN_BUDGET,
};
