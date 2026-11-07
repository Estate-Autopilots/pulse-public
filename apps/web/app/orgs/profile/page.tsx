import { api } from "../../lib/api";
import { Page, PageHeader } from "../../ui";
import { ProfileView, type Portable } from "./view";

// ORG: the profile that travels with the Pulse account: what you write, your skills, badges and highlights you choose to
// carry, and what each of your organisations may see. Nothing of an organisation's own records travels.
export default async function PortableProfile() {
  const [profile, choices] = await Promise.all([api<Portable | null>("account/profile"), api<{ tasks: { id: string; title: string; on: string }[] }>("account/highlight-choices")]);
  return <Page><PageHeader title="Your profile everywhere" back={{ href: "/orgs", label: "Organisations" }} context={["Carried into every organisation you join, only as much as you allow"]} />
    <ProfileView initial={profile.data ?? null} error={profile.error ?? null} tasks={choices.data?.tasks ?? []} /></Page>;
}
