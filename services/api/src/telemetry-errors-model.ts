// ERROR-SWEEP (owner, 17 Nov 2026): the error budget. Every error people hit is grouped into a cause (one row per
// cause, not per message), counted per day, and marked new, back or known, so a regression shows the same day it ships.
// Pure functions: the route (telemetry-errors.ts) reads the rows; tests feed synthetic ones.

export type ErrorRow = {
  day: string;               // the company's calendar day, YYYY-MM-DD
  kind: string;              // error.js, error.promise, error.stream, error.call, api (browser), api.server
  name: string | null;       // the message, stream or route ("GET /api/v0/calls")
  status: number | null;
  page: string | null;
  person: string | null;
  err: string | null;        // detail.err of a browser call: network | abort
  bg: boolean;               // the page was in the background
  who: string | null;        // detail.who of a server call: key | anon | null (a person)
  n: number;
};

export type Cause = {
  key: string; title: string; label: string; area: "screen" | "live" | "server" | "refused" | "connection";
  people: number; total: number; perDay: number[]; firstSeen: string; lastSeen: string;
  state: "new" | "back" | "known"; pages: string[];
};

/** "Cannot read properties of undefined (reading 'x')" stays; ids and numbers in a message become one shape. */
export function shape(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\b\d{2,}\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const AREA_LABEL: Record<string, string> = {
  "error.js": "Script error", "error.promise": "Script error", "error.boundary": "Screen failed", "error.resource": "Missing file",
  "error.stream": "Live updates dropped", "error.call": "Call did not connect",
};

/** "POST /api/v0/money/import" -> "money import": what a route is about, in words (ids and versions left out). */
export function thing(route: string): string {
  const path = route.replace(/^[A-Z]+ /, "").replace(/[?#].*$/, "").replace(/^\/(api\/)?v\d+\//, "").replace(/^\//, "");
  const words = path.split("/").filter((p) => p && !p.startsWith(":") && p !== "N" && !/^[0-9a-f-]{8,}$/i.test(p)).map((p) => p.replace(/[-_]+/g, " "));
  return words.join(" ").trim().slice(0, 60) || "a page";
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const STREAM: Record<string, string> = { calls: "calls", chats: "chats", screen: "AI on screen" };
const REFUSED: Record<number, string> = { 400: "not accepted", 403: "not allowed", 404: "not found", 409: "clashed with a change", 422: "not accepted", 429: "too many tries" };

/**
 * The cause of one error row, or null when it is not an error a person hit:
 * - a browser read that failed because the device was offline or the page was left (status 0 / aborted);
 * - a server answer to an API key or a signed-out caller below 500 (probes and integrations: their own budget);
 * - 401 (signed out: the sign-in screen handles it) and 404 on a switched-off module's poll.
 */
export function causeOf(r: ErrorRow): { key: string; title: string; label: string; area: Cause["area"] } | null {
  if (r.kind.startsWith("error.")) {
    const what = AREA_LABEL[r.kind] ?? "Error";
    const name = shape(r.name ?? "unknown");
    if (r.kind === "error.stream") {
      const stream = name.match(/\/api\/v0\/([a-z]+)\/events/)?.[1] ?? "";
      return { key: `stream:${name}`, title: `Live updates stopped (${STREAM[stream] ?? (stream || "a page")})`, label: name.replace(/^SSE /, ""), area: "live" };
    }
    if (r.kind === "error.call") return { key: `call:${name}`, title: "A call did not connect", label: name, area: "connection" };
    const title = r.kind === "error.boundary" ? "A screen failed to open" : r.kind === "error.resource" ? "A file failed to load" : "Something broke on a page";
    return { key: `${r.kind === "error.promise" ? "error.js" : r.kind}:${name}`, title, label: `${what}: ${name}`, area: "screen" };
  }
  const status = r.status ?? 0;
  const route = shape(r.name ?? "?");
  if (r.kind === "api") {
    // Status 0 is the device offline or the page left; 500 and refusals are counted once, from the server's own answer.
    // 502-504 never reach the API (it was restarting or busy), so only the browser saw them.
    if (status >= 502 && status <= 504) return { key: `api:${route}:gateway`, title: `${cap(thing(route))} did not load during an update`, label: `${route} (${status})`, area: "server" };
    return null;
  }
  if (r.kind === "api.server") {
    if (status >= 500) return { key: `server:${route}:${status}`, title: `${cap(thing(route))} failed on the server`, label: `${route} (${status})`, area: "server" };
    if (status < 400 || status === 401 || r.who === "key" || r.who === "anon" || !r.person) return null;
    if (status === 404 && /^GET /.test(route)) return null; // reads of something gone or switched off
    return { key: `refused:${route}:${status}`, title: `${cap(thing(route))}: ${REFUSED[status] ?? "refused"}`, label: `${route} (${status})`, area: "refused" };
  }
  return null;
}

/** Days from first to last inclusive (YYYY-MM-DD, calendar days). */
export function dayList(last: string, count: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Group rows into causes for the days shown. Rows may start before the shown days (the look-back that tells new from
 * known). new: first seen today or yesterday. back: seen today or yesterday after 3 or more quiet days. known: the rest.
 */
export function errorBudget(rows: ErrorRow[], shown: string[]) {
  const today = shown[shown.length - 1], yesterday = shown[shown.length - 2] ?? today;
  const index = new Map(shown.map((d, i) => [d, i]));
  const by = new Map<string, { title: string; label: string; area: Cause["area"]; people: Set<string>; perDay: number[]; days: Set<string>; first: string; last: string; pages: Map<string, number> }>();
  for (const r of rows) {
    const c = causeOf(r);
    if (!c) continue;
    let g = by.get(c.key);
    if (!g) by.set(c.key, g = { title: c.title, label: c.label, area: c.area, people: new Set(), perDay: shown.map(() => 0), days: new Set(), first: r.day, last: r.day, pages: new Map() });
    g.days.add(r.day);
    if (r.day < g.first) g.first = r.day;
    if (r.day > g.last) g.last = r.day;
    const i = index.get(r.day);
    if (i === undefined) continue;
    g.perDay[i] += r.n;
    if (r.person) g.people.add(r.person);
    if (r.page) g.pages.set(r.page, (g.pages.get(r.page) ?? 0) + r.n);
  }
  const causes: Cause[] = [];
  for (const [key, g] of by) {
    const total = g.perDay.reduce((a, b) => a + b, 0);
    if (!total) continue;
    const recent = g.last >= yesterday;
    const quiet = [...g.days].filter((d) => d < yesterday).sort().pop();
    const gap = quiet ? (Date.parse(yesterday) - Date.parse(quiet)) / 86_400_000 : 0;
    const state: Cause["state"] = g.first >= yesterday ? "new" : recent && gap > 3 ? "back" : "known";
    causes.push({ key, title: g.title, label: g.label, area: g.area, people: g.people.size, total, perDay: g.perDay, firstSeen: g.first, lastSeen: g.last, state,
      pages: [...g.pages].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p) });
  }
  // New, then back again (both are regressions), then the rest; within each, most people first.
  const rank = { new: 0, back: 1, known: 2 } as const;
  causes.sort((a, b) => rank[a.state] - rank[b.state] || b.people - a.people || b.total - a.total || a.key.localeCompare(b.key));
  const perDay = shown.map((day, i) => {
    let total = 0, fresh = 0;
    for (const c of causes) { total += c.perDay[i]; if (c.firstSeen >= shown[Math.max(0, i - 1)] && c.firstSeen <= day) fresh += c.perDay[i]; }
    return { day, total, fresh };
  });
  return {
    perDay, causes,
    today: { errors: perDay[perDay.length - 1]?.total ?? 0, yesterday: perDay[perDay.length - 2]?.total ?? 0,
      newCauses: causes.filter((c) => c.state === "new").length, backCauses: causes.filter((c) => c.state === "back").length,
      open: causes.filter((c) => c.lastSeen >= yesterday).length },
    since: today,
  };
}
