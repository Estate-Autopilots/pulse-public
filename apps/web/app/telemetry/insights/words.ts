// TOKENS-TELEMETRY: the kinds of AI work in plain words (shared by the Insights page and its charts).
const TYPE_NAME: Record<string, string> = { "task.daily": "Daily look", "task.assigned": "New task", "task.mention": "Mention", "task.comment": "Task comment", "task.continue": "Carry on",
  "task.returned": "Sent back", "task.subtask": "Sub-task", "task.direct": "Chat answer", "task.look": "Task look", "chat.quote": "Quote chat", "chat.money": "Money chat", "chat.short": "Short chat", "chat.ask": "Question", "chat.other": "Other chat" };
export const typeName = (t: string) => TYPE_NAME[t] ?? t;
