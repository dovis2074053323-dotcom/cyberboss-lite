const { buildProactiveTurnPrompt } = require("./proactive-turn-builder");
const { evaluateProactiveResult } = require("./proactive-result-schema");

// The real text always goes out over WeChat via sendMessage. Clawd receives
// only Morrow's reply_ready semantic event, so this runner has no visual
// output side effect of its own.
function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

// Executes exactly one queued proactive message end to end: render the round-1
// prompt, call the runtime with the narrow proactive contract, and if it comes
// back `need_context`, fetch a fresher on-demand Accessibility read
// (task #12) and run exactly one more round before applying a decision.
// Deliberately mirrors intentions-store.js's executeDueIntentions shape (pure
// function, every effect goes through an injected callback) so this is
// testable without a real Claude process, WeChat account, or Supabase project
// — the caller (app.js's runProactiveDrainTick) supplies the real ones, tests
// supply stubs.
//
// Hard cap at two rounds: proactive-turn-builder.js's round-2 prompt already
// drops need_context from the menu, and if the model ignores that and asks
// again anyway, that's treated as a contract violation (falls back to silent)
// rather than a third round — one wake-up must never turn into an unbounded
// chain of Claude calls.
async function processProactiveMessage(message, {
  callRuntime,           // (prompt) => Promise<{ structuredResult }>
  fetchRefreshedContext, // () => Promise<Array|{error}> — task #12 round 2 fetch
  sendMessage,           // (text) => Promise<boolean>
  markAgentMessageSent,  // (nowIso) => void — synchronous, local bookkeeping only
  onLog = () => {},
}) {
  let evaluation = await runRound(message, buildProactiveTurnPrompt(message.bundle), callRuntime, onLog);

  if (evaluation.action === "need_context") {
    onLog(`proactive turn ${message.id} requested need_context — fetching a fresher Accessibility read (round 2)`);
    const refreshedContext = await Promise.resolve()
      .then(() => fetchRefreshedContext())
      .catch((error) => ({ error: formatError(error) }));

    const round2Prompt = buildProactiveTurnPrompt(message.bundle, { refreshedContext });
    evaluation = await runRound(message, round2Prompt, callRuntime, onLog);

    if (evaluation.action === "need_context") {
      onLog(`proactive turn ${message.id} asked for need_context again on round 2 — capped at two rounds, falling back to silent`);
      evaluation = { action: "silent", message: null, reason: "need_context repeated past the two-round cap" };
    }
  }

  return applyDecision(message, evaluation, { sendMessage, markAgentMessageSent, onLog });
}

// One runtime call + validation, normalized so both a thrown error and a
// fatal/malformed structured result land on the same `{action:"silent"}`
// shape the caller can treat uniformly — never forwards a possibly-malformed
// `message`.
async function runRound(message, prompt, callRuntime, onLog) {
  let structuredResult;
  try {
    const result = await callRuntime(prompt);
    structuredResult = result?.structuredResult;
  } catch (error) {
    const reason = `runtime_error: ${formatError(error)}`;
    onLog(`proactive turn ${message.id} (${message.source}) failed: ${reason}`);
    return { action: "silent", message: null, reason };
  }

  const evaluation = evaluateProactiveResult(structuredResult);
  if (evaluation.fatal) {
    const reason = `invalid_result: ${evaluation.errors.join("; ")}`;
    onLog(`proactive turn ${message.id} (${message.source}) rejected: ${reason}`);
    return { action: "silent", message: null, reason };
  }
  return evaluation;
}

// By the time this runs, `evaluation.action` is guaranteed to be one of
// send_message/silent/defer — need_context is fully resolved (round 2 or the
// two-round cap fallback) before processProactiveMessage calls this.
async function applyDecision(message, evaluation, { sendMessage, markAgentMessageSent, onLog }) {
  if (evaluation.action === "send_message") {
    const sent = await Promise.resolve()
      .then(() => sendMessage(evaluation.message))
      .catch((error) => {
        onLog(`proactive turn ${message.id} send failed: ${formatError(error)}`);
        return false;
      });
    if (sent) {
      markAgentMessageSent(new Date().toISOString());
    }
    return { id: message.id, source: message.source, action: "send_message", sent, reason: evaluation.reason };
  }

  // silent | defer: a real decision, deliberately no side effect — see
  // proactive-result-schema.js's module comment on why these two exist
  // separately (silent = decided against it; defer = didn't decide).
  return { id: message.id, source: message.source, action: evaluation.action, sent: false, reason: evaluation.reason };
}

module.exports = { processProactiveMessage };
