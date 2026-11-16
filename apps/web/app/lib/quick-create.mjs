// KAZUK-REST (slice 3; Willow Lane: "on the phone there is no quick way to add a task like C on the computer"). The phone's
// floating "+" opens the same Create dialog as the C key, on every staff page, except where a page already has its own
// "+ New" (Work and My day: PROJECTS-CREATE), where something else lives at the bottom (a chat's message box, the Billing
// editor's save bar, a call, the meeting recorder) and on sign-in pages. Pure; unit-tested beside it.

const OWN_BUTTON = [/^\/tasks(\/|$|\?)/, /^\/my-day(\/|$|\?)/];
const BOTTOM_TAKEN = [/^\/chats(\/|$|\?)/, /^\/erp\/documents\/[^/]+/, /^\/erp\/new(\/|$|\?)/, /^\/meetings\/[^/?]+/, /^\/calls(\/|$|\?)/, /^\/listen(\/|$|\?)/];
const SIGNED_OUT = [/^\/login(\/|$|\?)/, /^\/signup(\/|$|\?)/, /^\/join(\/|$|\?)/, /^\/invited(\/|$|\?)/, /^\/accept(\/|$|\?)/, /^\/oauth(\/|$|\?)/, /^\/welcome(\/|$|\?)/, /^\/portal(\/|$|\?)/, /^\/client(\/|$|\?)/];

/** Does the phone's floating "+" show on this path? */
export function quickCreateShows(path) {
  const p = typeof path === "string" && path.startsWith("/") ? path : "/";
  return ![...OWN_BUTTON, ...BOTTOM_TAKEN, ...SIGNED_OUT].some((re) => re.test(p));
}
