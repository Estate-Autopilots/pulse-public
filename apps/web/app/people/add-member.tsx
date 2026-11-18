// The AI employee's runtimes and tools: used by Add people (people/add/add-flow.tsx) and the AI employee's profile.
// FIX-PEOPLE-MONEY C1: the old "Add member" button that lived here is merged into Add people.
// CHAT-WORK: an AI employee is added like anyone (the same person record and profile: name, role, pod, team, who it
// reports to); the switch adds only what is set for AI. Its tools and where it speaks can be changed on its profile.
export const MODELS: Record<string, string[]> = { claude: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5"], codex: ["gpt-6-luna", "gpt-6", "gpt-6-codex"] };
export const TOOLS = [
  { value: "chats", label: "Chats", hint: "Answers when asked in its groups and direct messages" },
  { value: "tasks", label: "Tasks", hint: "Takes tasks given to it, works them on the task (plan, comments, files) and sends them for review" },
  { value: "memory", label: "Memory", hint: "Keeps notes of what it learns" },
  { value: "board", label: "Board", hint: "Hands bigger work to the company board when a leader agrees" },
] as const;
