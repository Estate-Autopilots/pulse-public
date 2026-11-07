import { api, holdAtGate } from "../../lib/api";
import { Page, PageHeader } from "../../ui";
import { AddClient } from "./add-client";

export const metadata = { title: "Add a client" };
export const dynamic = "force-dynamic";

/** SELF-SERVE (owner, 4 Nov 2026): a professional adds a client, who gets a one-click link to their own space. In the
 *  space's own words (a practice may say patients; Settings → Industry & roles). */
export default async function AddClientPage() {
  await holdAtGate();
  const w = (await api<{ words: Record<string, string> | null }>("account/about")).data?.words ?? {};
  const one = w.client ?? "Client", many = w.clients ?? "Clients";
  return <Page><PageHeader title={`Add a ${one.toLowerCase()}`} back={{ href: "/clients", label: many }} /><AddClient one={one} many={many} /></Page>;
}
