// VISIBLE (owner, 25 Oct 2026: "most of the things made in the last update: nothing is visible"): what the last update
// brought, each with its way in. The Home panel (until dismissed) and /whats-new read this one list. `who`: "all", or
// "leaders" (admins and leadership), "admins". Plain data: no React, no server-only imports.

/** The update the panel announces; dismissing remembers this id (a newer update shows again). */
export const WHATS_NEW_ID = "2026-10-25";
export const WHATS_NEW_COOKIE = "pulse_whats_new";

export const WHATS_NEW = [
  { id: "groups-hub", title: "All your groups in one place", text: "Chats → Groups: every group with its client, project, pod and status, who is waiting on us, filters and AI employees in groups.", href: "/chats/groups", cta: "Open the groups", who: "all" },
  { id: "client-groups", title: "Client groups", text: "Every client's group, the ones waiting on us first. Leaders see every group's facts.", href: "/chats/groups?kinds=client", cta: "Client groups", who: "all" },
  { id: "wa-native", title: "WhatsApp groups are Pulse chats now", text: "The imported WhatsApp history is in each group's own chat: search it, jump to a date, reply in threads, see its photos, files and voice notes.", href: "/chats", cta: "Open Chats", who: "all" },
  { id: "insights", title: "Insights: client operations", text: "What the groups say about how a client is run: the service path, who waits, what clients ask, where it goes wrong, and six changes to make.", href: "/insights", cta: "Open Insights", who: "leaders" },
  { id: "signals", title: "WhatsApp signals", text: "Complaints, churn risk, payments and upsell openings found in the groups, each linked to its message.", href: "/chats/whatsapp/signals", cta: "See the signals", who: "leaders" },
  { id: "client-health", title: "Client health on every client", text: "A client's page → Overview: health, churn risk and why, groups waiting on us, both sides' answer times.", href: "/clients", cta: "Open Clients", who: "leaders" },
  { id: "client-portal", title: "Clients on Pulse", text: "Invite a client to their own space: shared quotations, invoices, requests, a group with the team and calls.", href: "/clients?tab=access", cta: "Pulse access", who: "leaders" },
  { id: "ai-consult", title: "AI employees ask a colleague first", text: "When an AI employee needs a date, a price or a file, it asks the right colleague in a direct message and drafts only from the answer.", href: "/learn/ai-employees", cta: "How it works", who: "all" },
  { id: "learn", title: "Learn Pulse", text: "Short tutorials with the real screens: close a deal, quotations, tasks, chats, leave, expenses, AI employees.", href: "/learn", cta: "Open Learn", who: "all" },
  { id: "product-map", title: "Product map", text: "Connect an app and Pulse lists its screens, user types and journeys, finds dead ends and keeps the plan for the next version.", href: "/product-map", cta: "Open the map", who: "leaders" },
  { id: "sales-xray", title: "Sales X-Ray sync", text: "Leads won in Sales X-Ray become clients here, and a client can be sent there as a lead. Calls link to the client.", href: "/apps/sales-xray", cta: "Open Sales X-Ray", who: "admins" },
  { id: "salary-list", title: "Salary by a named list", text: "Settings → Roles: choose by name who may read and change salaries (off until you switch it on).", href: "/settings?tab=roles", cta: "Roles & permissions", who: "admins" },
];

/** The items a person sees: by role label (the shell's) and without pages their company switched off or hid. */
export function whatsNewFor(roleLabel, isOff = () => false) {
  const leader = ["Organisation owner/admin", "Leadership", "HR and leadership"].includes(roleLabel ?? "");
  const admin = roleLabel === "Organisation owner/admin";
  return WHATS_NEW.filter((i) => (i.who === "all" || (i.who === "leaders" && leader) || (i.who === "admins" && admin)) && !isOff(i.href));
}
