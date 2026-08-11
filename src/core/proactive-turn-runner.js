const { buildProactiveTurnPrompt } = require("./proactive-turn-builder");
const { evaluateProactiveResult, evaluateMandatoryResult } = require("./proactive-result-schema");

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

// Exactly one runtime call per queue item. The caller has already rebuilt the
// observation bundle, refreshed Clawd context, acquired the host lock, and
// reserved daily budget before entering here.
async function processProactiveMessage(message, {
  prompt,
  callRuntime,
  sendMessage,
  markAgentMessageSent,
  onDeliveryFailed = () => {},
  onLog = () => {},
}) {
  const forced = message.forced === true || message.source === "mandatory_slot";
  const actualPrompt = prompt || buildProactiveTurnPrompt(message.bundle, {
    freshContext: message.freshContext,
    forced,
    candidate: message,
  });
  let structuredResult;
  try {
    const result = await callRuntime(actualPrompt);
    structuredResult = result?.structuredResult;
  } catch (error) {
    const reason = `runtime_error: ${formatError(error)}`;
    onLog(`proactive ${message.id} (${message.source}) failed: ${reason}`);
    return { id: message.id, source: message.source, action: forced ? "mandatory_failed" : "silent", sent: false, reason };
  }

  const evaluation = forced
    ? evaluateMandatoryResult(structuredResult)
    : evaluateProactiveResult(structuredResult);
  if (evaluation.fatal) {
    const reason = `invalid_result: ${evaluation.errors.join("; ")}`;
    onLog(`proactive ${message.id} (${message.source}) rejected: ${reason}`);
    return { id: message.id, source: message.source, action: forced ? "mandatory_failed" : "silent", sent: false, reason };
  }

  if (!forced && evaluation.action === "silent") {
    return { id: message.id, source: message.source, action: "silent", sent: false, reason: evaluation.reason };
  }

  const deliveryText = forced ? evaluation.message : evaluation.message;
  const sent = await Promise.resolve()
    .then(() => sendMessage(deliveryText))
    .catch((error) => {
      onLog(`proactive ${message.id} send failed: ${formatError(error)}`);
      return false;
    });
  if (sent) {
    await Promise.resolve(markAgentMessageSent(new Date().toISOString()));
  } else if (forced) {
    await Promise.resolve(onDeliveryFailed(deliveryText));
  }
  return {
    id: message.id,
    source: message.source,
    action: "send_message",
    sent,
    message: deliveryText,
    reason: evaluation.reason,
  };
}

module.exports = { processProactiveMessage };
