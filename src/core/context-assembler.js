// Spec §7: bounded per-turn context assembly, fixed order, no full history.
// Builds the single text string handed to `claude -p`; the model is steered
// toward structured JSON by the system prompt + --json-schema, not by the
// shape of this text.
function assembleTurnContext({
  agentName,
  nowIso,
  coreMemories = [],
  contextualMemories = [],
  currentState,
  openLoops = [],
  carryContext = null,
  episodeMessages = [],
  pendingResumeTopics = [],
  mergedText,
  receivedAtLocal,
  rolloverRequested = false,
}) {
  const sections = [];

  sections.push(`[MODE: reply]\n[NOW: ${nowIso}]`);
  sections.push(formatMemorySection("核心记忆", coreMemories));
  sections.push(formatMemorySection("相关记忆", contextualMemories));
  sections.push(formatCurrentStateSection(currentState));
  sections.push(formatOpenLoopsSection(openLoops));
  sections.push(formatCarryContextSection(carryContext));
  sections.push(formatEpisodeMessagesSection(episodeMessages));
  sections.push(formatResumeTopicsSection(pendingResumeTopics));
  sections.push(formatThisTurnSection({ receivedAtLocal, mergedText }));

  if (rolloverRequested) {
    sections.push("[ROLLOVER_REQUESTED: true — 本轮请在结构化结果中同时给出 handoff]");
  }

  return sections.filter(Boolean).join("\n\n");
}

function formatMemorySection(title, memories) {
  if (!memories.length) {
    return `== ${title} ==\n（无）`;
  }
  const lines = memories.map((memory) => `- [${memory.category}] ${memory.fact}`);
  return `== ${title} ==\n${lines.join("\n")}`;
}

function formatCurrentStateSection(currentState) {
  const state = currentState || {};
  const lines = [
    `currentActivity: ${formatValue(state.currentActivity)}`,
    `expectedReturnAt: ${formatValue(state.expectedReturnAt)}`,
    `recentMood: ${formatValue(state.recentMood)}`,
    `lastUserMessageAt: ${formatValue(state.lastUserMessageAt)}`,
    `lastAgentMessageAt: ${formatValue(state.lastAgentMessageAt)}`,
  ];
  return `== 当前状态 ==\n${lines.join("\n")}`;
}

function formatOpenLoopsSection(openLoops) {
  if (!openLoops.length) {
    return "== 未完成事项 ==\n（无）";
  }
  const lines = openLoops.map((loop) => `- [${loop.id}] ${loop.summary}`);
  return `== 未完成事项 ==\n${lines.join("\n")}`;
}

function formatCarryContextSection(carryContext) {
  if (!carryContext) {
    return "";
  }
  if (carryContext.type === "handoff") {
    const handoff = carryContext.handoff;
    const lines = [
      `概要: ${handoff.summary}`,
      `语气: ${handoff.tone}`,
    ];
    if (handoff.openLoops?.length) {
      lines.push(`未完成: ${handoff.openLoops.join("; ")}`);
    }
    if (handoff.carryForward?.length) {
      lines.push(`需延续: ${handoff.carryForward.join("; ")}`);
    }
    return `== 上一段对话交接 ==\n${lines.join("\n")}`;
  }
  const lines = carryContext.messages.map((message) => `${message.role}: ${message.text}`);
  return `== 上一段对话（最后几条）==\n${lines.join("\n")}`;
}

function formatEpisodeMessagesSection(episodeMessages) {
  if (!episodeMessages.length) {
    return "== 当前对话 ==\n（无）";
  }
  const lines = episodeMessages.map((message) => `${message.role}: ${message.text}`);
  return `== 当前对话 ==\n${lines.join("\n")}`;
}

function formatResumeTopicsSection(pendingResumeTopics) {
  if (!pendingResumeTopics.length) {
    return "";
  }
  const lines = pendingResumeTopics.map((intention) => `- ${intention.reason}${intention.context ? `（${intention.context}）` : ""}`);
  return `== 待唤醒的话题 ==\n${lines.join("\n")}`;
}

function formatThisTurnSection({ receivedAtLocal, mergedText }) {
  const header = receivedAtLocal ? `[${receivedAtLocal}]` : "";
  return `== 本轮用户消息 ==\n${header ? `${header}\n` : ""}${mergedText}`;
}

function formatValue(value) {
  return value === null || value === undefined || value === "" ? "（无）" : String(value);
}

module.exports = { assembleTurnContext };
