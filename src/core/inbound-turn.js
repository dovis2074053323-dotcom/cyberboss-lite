// Lite handles text only (spec 五: "只处理文本"). No attachments, no vision, no stickers.

function buildInboundDraft(normalized) {
  return {
    ...normalized,
    text: normalizeText(normalized?.text),
  };
}

// Merge buffered messages accumulated during the 10s idle window (or while a turn
// was in flight) into a single runtime turn, in arrival order.
function mergeBufferedInboundTexts(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => normalizeText(message?.text))
    .filter(Boolean)
    .join("\n\n");
}

function assembleRuntimeTurnText({ text, receivedAt }) {
  const localTime = formatWechatLocalTime(receivedAt);
  const body = normalizeText(text);
  return localTime ? `[${localTime}]\n${body}` : body;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

module.exports = {
  buildInboundDraft,
  mergeBufferedInboundTexts,
  assembleRuntimeTurnText,
};
