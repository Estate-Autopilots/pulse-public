// UX-PEOPLE: People → Access. One page for who can do what: people × capabilities, role templates, bulk changes and
// "what can this person do". Organisation admins change roles here; the service makes the same checks as before.
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { api, getMe } from "../../lib/api";
import { Message } from "../../ui";
import { CalmPage, EmptyState, CalmHeader, StatTile, StatTiles, calm } from "../../components";
import type { RulesData } from "../../settings/work-rules";
import type { SettingsData } from "../../settings/types";
import { AccessMatrix } from "./matrix";

export const metadata = { title: "Access" };

export default async function AccessPage() {
  const me = await getMe();
  if (me.error) return <Message text={me.error} />; if (!me.data) return null;
  if (me.data.role !== "admin") return <CalmPage>
    <CalmHeader eyebrow="People" title="Access" back={{ href: "/people", label: "People" }} />
    <EmptyState icon={ShieldCheck} title="Organisation admins change access" text="Roles and restricted HR permissions are changed by an organisation admin. Your own access has not changed. The work rules show what each kind of account can do.">
      <Link href="/settings?tab=work-rules" className={calm.btnPrimary}>See the work rules</Link>
    </EmptyState>
  </CalmPage>;
  const [settings, rules] = await Promise.all([api<SettingsData>("settings"), api<RulesData>("work/rules")]);
  if (!settings.data) return <Message text={settings.error ?? "Unavailable"} />;
  const s = settings.data;
  const people = s.people ?? [], roles = s.roles ?? [], grants = s.permissions ?? [];
  // Counted from the active people the table shows; holders who are no longer active are listed on their own below it.
  const active = new Set(people.map((p) => p.id));
  const withRole = new Set(roles.filter((r) => active.has(r.personId)).map((r) => r.personId)).size;
  const restricted = new Set(grants.filter((g) => g.effective !== false && active.has(g.personId)).map((g) => g.personId)).size;
  const admins = roles.filter((r) => r.role === "admin" && active.has(r.personId)).length;
  return <CalmPage label="Access">
    <CalmHeader eyebrow={`People · ${s.org?.name ?? "Your organisation"}`} title="Access" back={{ href: "/people", label: "People" }}
      lede="Who can do what: every person and what their roles let them do, in one table. Choose people to give or take a role; open a person to see everything they can do."
      stats={<StatTiles label="Access at a glance" count={4}>
        <StatTile label="People" value={people.length} />
        <StatTile label="With a role" value={withRole} />
        <StatTile label="Admins" value={admins} tone={admins < 2 ? "warn" : undefined} />
        <StatTile label="Restricted grants" value={restricted} />
      </StatTiles>} />
    <AccessMatrix data={{ roles, people, permissions: grants, canGrant: !!s.canGrant, canEdit: !!s.canEdit, salaryList: s.salaryList }} rules={rules.data ?? null} viewer={me.data.person} />
  </CalmPage>;
}
