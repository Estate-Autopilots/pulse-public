import { api } from "../../lib/api";
import Link from "next/link";
import { GamePage, PageHeader } from "../../kit/game";
import { ProfileView, type Portable, type Role } from "./view";
import css from "../orgs.module.css";

// ORG: the profile that travels with the Pulse account: what you write, your skills, badges and highlights you choose to
// carry, and what each of your organisations may see. Nothing of an organisation's own records travels.
export default async function PortableProfile() {
  // GAP-FOUNDER-VIEW (PM-07): the person's role in each company, from each company's own record.
  const [profile, choices, roles] = await Promise.all([api<Portable | null>("account/profile"), api<{ tasks: { id: string; title: string; on: string }[] }>("account/highlight-choices"),
    api<{ roles: Role[] }>("account/roles")]);
  // GAP-FOUNDER-VIEW: the game-feel kit's page frame, so the gutter and the title sit where "All my companies" has them.
  return <GamePage label="Your profile in all companies">
    <PageHeader eyebrow={<Link href="/orgs" className={css.backLink}>← Your companies</Link>} title="Your profile in all companies" shellTitle
      subtitle="Your details go with you to every company. You choose what each one sees." />
    <ProfileView initial={profile.data ?? null} error={profile.error ?? null} tasks={choices.data?.tasks ?? []} roles={roles.data?.roles ?? []} /></GamePage>;
}
