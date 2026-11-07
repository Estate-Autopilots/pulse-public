"use client";
// UX-PEOPLE (owner, 5 Nov 2026): Roles & permissions is the one permissions matrix (people × what they can do, role
// templates, bulk changes, "what can this person do"), the same as People → Access. The tab per role is gone: a person
// is changed in one place. The salary named-list switch stays on top of it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { dayTime } from "../lib/format";
import { post } from "../records";
import { AccessMatrix } from "../people/access/matrix";
import css from "./settings.module.css";
import type { PermissionGrant, RoleHolder, SalaryList, SettingsData } from "./types";
import type { RulesData } from "./work-rules";

const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";

// Who loses what when the named list goes on, in a sentence.
const losing = (list: SalaryList) => ([["salary", "salary access"], ["edit", "salary editing"]] as const)
  .map(([key, what]) => ({ names: list.byRoleOnly.filter((p) => p.loses === key).map((p) => p.name), what }))
  .filter((x) => x.names.length).map((x) => `${x.names.join(", ")} ${x.names.length === 1 ? "loses" : "lose"} ${x.what}`).join("; ");

/** Salary by named list for the organisation: off, HR and leadership see salaries by their role; on, only named people do. */
function SalaryListSwitch({ list, canGrant }: { list: SalaryList; canGrant: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function set(on: boolean) {
    if (!window.confirm(on ? `Only the people named under “Read salary” and “Edit salary” will see or change salaries. ${list.byRoleOnly.length ? `${losing(list)}; switch them on below first if they should keep it.` : "Everyone who sees or edits salaries now is named already."} Turn the named list on?`
      : "HR and leadership will see and change every salary by their role again. Turn the named list off?")) return;
    setBusy(true);
    try { await post("settings/salary-list", { on }); notify({ id: "salary-list", tone: "success", title: on ? "Salaries are by named list now" : "Salaries are by role again", timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "salary-list", tone: "error", title: "The salary list was not changed", message: message(e) }); } finally { setBusy(false); }
  }
  return (
    <p className={css.note} data-tone="neutral">
      <label className={css.switch} title={canGrant ? undefined : "Only an admin who holds “Read salary” can change this"}>
        <input type="checkbox" checked={list.on} disabled={!canGrant || busy} onChange={() => set(!list.on)} aria-label="Salary by named list" />
        <span aria-hidden="true" /><small>{list.on ? "On" : "Off"}</small>
      </label>
      <span><b>Salary by named list.</b> {list.on ? "Only the people switched on under “Read salary” and “Edit salary” see or change salaries, whatever their role." : `HR and leadership see salaries by their role. Switch on to let only the people named below see them${list.byRoleOnly.length ? ` (${losing(list)})` : ""}.`}{list.changedBy && list.changedAt ? ` Changed by ${list.changedBy}, ${dayTime(list.changedAt)}.` : ""}</span>
    </p>
  );
}

/** Roles & permissions: the salary switch and the matrix. */
export function Roles({ roles, people, permissions, canGrant, canEdit, viewer, rules = null, salaryList = { on: false, changedAt: null, changedBy: null, byRoleOnly: [] } }: { roles: RoleHolder[]; people: SettingsData["people"]; permissions: PermissionGrant[]; canGrant: boolean; canEdit: boolean; viewer: string | null; rules?: RulesData | null; salaryList?: SalaryList }) {
  return <div className={css.access} data-grow="">
    <div className={css.accessTop}><SalaryListSwitch list={salaryList} canGrant={canGrant} /><Link href="/people/access" className={css.accessOpen}>Open as a page<ArrowUpRight size={14} aria-hidden="true" /></Link></div>
    <AccessMatrix data={{ roles, people, permissions, canGrant, canEdit, salaryList }} rules={rules} viewer={viewer} />
  </div>;
}
