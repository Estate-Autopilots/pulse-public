import { Tabs } from "../ui";

/** Clients are a separate world (UX-TASKS): the client directory and the packages they bought sit side by side here;
 *  the work that delivers a package (its fulfilment project) lives under Work. */
const ITEMS = [{ href: "/clients", label: "Directory" }, { href: "/projects", label: "Client projects" }, { href: "/clients?tab=renewals", label: "Renewals" }, { href: "/clients?tab=master", label: "Client master" }];
/** UX-TASKS-2: `words` carries the business model's names (Customers, Releases) where the page knows them. */
export function ClientTabs({ current, words }: { current: string; words?: { clients: string; clientProjects: string } }) {
  const items = words ? ITEMS.map((i) => i.href === "/projects" ? { ...i, label: words.clientProjects } : i.href === "/clients" && words.clients !== "Clients" ? { ...i, label: words.clients } : i) : ITEMS;
  return <Tabs items={items} current={current} />;
}
