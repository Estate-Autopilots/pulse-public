import type { Me } from "../lib/api";

/** OWNER-HOME: Focus (the calm home) or Max (every panel) for leadership's dashboard. The address decides first, then the
 *  remembered choice (the pulse.home.mode cookie); Focus by default. */
export function homeMode(params: { mode?: string | null; classic?: string | null }, remembered?: string): "focus" | "max" {
  return params.mode === "max" || params.classic === "1" ? "max" : params.mode === "focus" ? "focus" : remembered === "max" ? "max" : "focus";
}

/** EST-2093: whether this request draws the calm home, which restyles the shell (html[data-pulse-focus]). The root layout
 *  marks <html> from the first paint with it, so the rail and the top bar do not move while the page loads. It follows
 *  the dashboard page: /home always; /dashboard without a tab or view for leadership (admin or leadership, the API's
 *  leadership view), unless the role lands on the sales home. Focus and Max now share this shell. */
export function drawsCalmHome(path: string, search: URLSearchParams, me: Pick<Me, "role" | "home" | "person" | "mustChange"> | null | undefined) {
  if (!me || me.mustChange) return false;
  if (path === "/home") return true;
  if (path !== "/dashboard" || search.get("tab") || search.get("view")) return false;
  if (me.home === "sales" && me.person) return false;
  if (me.role !== "admin" && me.role !== "leadership") return false;
  return true;
}
