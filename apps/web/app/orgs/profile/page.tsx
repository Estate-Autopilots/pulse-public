import { api } from "../../lib/api";
import { GamePage } from "../../kit/game";
import { ProfileView, type Portable, type Role } from "./view";

// ORG: the profile that travels with the Pulse account: what you write, your skills, badges and highlights you choose to
// carry, and what each of your organisations may see. Nothing of an organisation's own records travels.
// PROFILE-2: the profile's own header is the page's header (no second title above it).
export default async function PortableProfile() {
  // GAP-FOUNDER-VIEW (PM-07): the person's role in each company, from each company's own record.
  const [profile, choices, roles] = await Promise.all([api<Portable | null>("account/profile"), api<{ tasks: { id: string; title: string; on: string }[] }>("account/highlight-choices"),
    api<{ roles: Role[] }>("account/roles")]);
  return <GamePage label="Your profile">
    <ProfileView initial={profile.data ?? null} error={profile.error ?? null} tasks={choices.data?.tasks ?? []} roles={roles.data?.roles ?? []} /></GamePage>;
}
