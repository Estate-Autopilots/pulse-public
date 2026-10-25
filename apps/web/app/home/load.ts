import { api, getMe, type HomeData, type Insights } from "../lib/api";
import type { LiveState } from "../finance/types";
import type { Home as TaskHome } from "../tasks/types";
import { think, type Brief } from "./brain";
import type { MaxData } from "./deep";

export type CalmProps = { brief: Brief; hello: string; today: string; max?: MaxData; off: string[] };

/** OWNER-HOME: everything Focus mode needs, ranked on the server. Each source is optional: a role without finance access
 *  simply has no money cards. `pre` lets the dashboard pass what it already fetched. */
export async function loadCalm(pre?: { home?: HomeData | null; insights?: Insights | null; max?: boolean; off?: string[] }): Promise<CalmProps> {
  const [me, live, insights, home, tasks] = await Promise.all([
    getMe(), api<LiveState>("finance/live"),
    pre?.insights !== undefined ? Promise.resolve({ data: pre.insights }) : api<Insights>("insights"),
    pre?.home !== undefined ? Promise.resolve({ data: pre.home }) : api<HomeData>("home"),
    api<TaskHome>("tasks/home"),
  ]);
  const modulesOff = pre?.off ?? me.data?.modules?.off ?? [];
  const off = me.data?.companyModules?.finance === false && !modulesOff.includes("money") ? [...modulesOff, "money"] : modulesOff;
  const model = off.includes("money") ? null : live.data?.model ?? null;
  const visibleHome = home.data && off.includes("hr") ? { ...home.data, attendance: null } : home.data ?? null;
  const brief = think({
    me: me.data ? { name: me.data.name, role: me.data.role } : null,
    live: model, insights: insights.data ?? null, home: visibleHome, tasks: tasks.data ?? null,
  });
  const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const today = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(new Date());
  const max = pre?.max ? (await import("./deep")).deep({ brief, live: model, insights: insights.data ?? null, home: visibleHome, off }) : undefined;
  // E2E-4P: someone in more than one organisation (a client back in their own, a partner) sees which one this is.
  const where = (me.data?.account?.orgs?.length ?? 0) > 1 ? me.data?.orgName : null;
  // QA-1024: just after midnight the home said "Good morning"; before 5 it says what the chats home says.
  return { brief, max, off, hello: `${hour < 5 ? "Working late" : `Good ${part}`}${brief.name ? `, ${brief.name}` : ""}.`, today: where ? `${today} · ${where}` : today };
}
