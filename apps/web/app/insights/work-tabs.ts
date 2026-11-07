// WA-INTEL (1070): Insights → From the chats and its views. A plain module, so the server page and the client components
// read the same list (a value imported from a "use client" file is only a reference on the server).
export const CHATS_TAB = { key: "chats", label: "From the chats" };
export const WORK_VIEWS = [{ key: "work", label: "Open work" }, { key: "decisions", label: "Decisions" }, { key: "mistakes", label: "Mistakes" },
  { key: "runs", label: "Best & worst runs" }, { key: "team", label: "Team" }];
