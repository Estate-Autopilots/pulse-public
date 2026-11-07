// PR-STUDIO-2: which post the Post kit opens when none is named: the next one due (today's first that is not posted,
// else the next scheduled), so "Post kit" is always one click from the flow bar. Shared by the page and the screens.
import type { FlowData, Post } from "./flow-types";

const open = (p: Post) => p.stage !== "posted" && p.stage !== "measured" && !!p.day;
const at = (p: Post) => `${p.day ?? "9999-99-99"} ${p.time ?? "99:99"}`;

export function kitPost(d: Pick<FlowData, "posts" | "today">, id: string | null): Post | null {
  if (id) return d.posts.find((p) => p.id === id) ?? null;
  const today = d.today ?? "";
  const due = d.posts.filter((p) => open(p) && (p.day ?? "") >= today).sort((a, b) => at(a).localeCompare(at(b)));
  return due[0] ?? d.posts.filter(open).sort((a, b) => at(b).localeCompare(at(a)))[0] ?? null;
}

/** Today's posts in time order: "what to post where today". */
export function todays(d: Pick<FlowData, "posts" | "today">): Post[] {
  return d.posts.filter((p) => p.day === d.today).sort((a, b) => at(a).localeCompare(at(b)));
}
