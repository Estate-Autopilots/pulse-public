"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Target } from "lucide-react";
import { styles } from "../ui";
import css from "./people-view.module.css";

export type RoleTarget = { role: string; perWeek: number; unit: string | null };

/** WORK-TAB: leadership sets each role's weekly target in place (Kazuk's "output vs the role's target"). */
export function RoleTargets({ roles, targets }: { roles: string[]; targets: RoleTarget[] }) {
  const router = useRouter();
  const find = (r: string) => targets.find((t) => t.role.toLowerCase() === r.toLowerCase());
  const [rows, setRows] = useState(() => roles.map((r) => ({ role: r, perWeek: find(r)?.perWeek?.toString() ?? "", unit: find(r)?.unit ?? "" })));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (i: number) => {
    const r = rows[i]; setBusy(r.role); setError(null);
    try {
      const res = await fetch("/api/v0/work/role-targets", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: r.role, perWeek: r.perWeek.trim() ? Number(r.perWeek) : null, unit: r.unit.trim() || null }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Could not save the target");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const set = (i: number, k: "perWeek" | "unit", v: string) => setRows((x) => x.map((r, j) => j === i ? { ...r, [k]: v } : r));
  return <details className={css.targets}>
    <summary><Target size={14} aria-hidden="true" />Weekly targets per role<small>{targets.length ? `${targets.length} set` : "none set yet"}</small></summary>
    <p className={css.cardLine}>What one person in the role finishes in a normal week. Their rows then read “4 of 6” against it. Leave it empty for no target.</p>
    <ul className={css.targetList}>{rows.map((r, i) => <li key={r.role}>
      <span className={css.targetRole}>{r.role}</span>
      <input className={styles.input} inputMode="numeric" aria-label={`${r.role}: tasks per week`} placeholder="per week" value={r.perWeek} onChange={(e) => set(i, "perWeek", e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} />
      <input className={styles.input} aria-label={`${r.role}: what is counted`} placeholder="tasks, videos, image sets…" value={r.unit} maxLength={40} onChange={(e) => set(i, "unit", e.target.value)} />
      <button type="button" className={styles.btn} disabled={busy !== null} onClick={() => save(i)}>{busy === r.role ? "Saving…" : "Save"}</button>
    </li>)}</ul>
    {error ? <p className={css.targetError} role="alert">{error}</p> : null}
  </details>;
}
