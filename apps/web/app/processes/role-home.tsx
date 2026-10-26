// FLOW-E (owner, 21 Oct 2026: roles as data; "a person can hold several roles"): the tiles of each role the person
// holds, at the top of their home and My steps. Each tile is a count of steps from every process (mine, the role's, or
// late) with the first few; a role's tiles are set in Settings → Industry & roles. Nothing shows for someone with no role.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import css from "./role-home.module.css";

type Item = { id: string; title: string; run: string; due: string | null; late: boolean; href: string };
type Tile = { key: string; label: string; of: "mine" | "role" | "runs"; late?: boolean; count: number; items: Item[]; href: string };
export type RoleHomeData = { roles: { key: string; name: string; tiles: Tile[] }[]; steps: unknown[]; upcoming: number; asked: number };

export function RoleHome({ data, compact }: { data: RoleHomeData | null | undefined; compact?: boolean }) {
  if (!data?.roles.length) return null;
  return <section className={css.home} aria-label="Your roles" data-compact={compact ? "" : undefined}>
    <header><b>{data.roles.length === 1 ? `As ${data.roles[0].name}` : "Your roles"}</b>
      <small>{data.roles.length > 1 ? data.roles.map((r) => r.name).join(" · ") : "Your steps from every process"}</small></header>
    {data.roles.map((r) => <div key={r.key} className={css.role} aria-label={r.name}>
      {data.roles.length > 1 ? <h3>{r.name}</h3> : null}
      <ul className={css.tiles}>{r.tiles.map((t) => <li key={t.key} data-late={t.late && t.count ? "" : undefined} data-zero={!t.count ? "" : undefined}>
        <Link href={t.href} aria-label={`${r.name}: ${t.label}, ${t.count}`}>
          <span className={css.count}>{t.count}</span><span className={css.label}>{t.label}<ArrowRight size={13} aria-hidden="true" /></span>
          {!compact && t.items.length ? <span className={css.items}>{t.items.slice(0, 2).map((i) => <small key={i.id} data-late={i.late ? "" : undefined}>{i.title} · {i.run}</small>)}</span> : null}
        </Link></li>)}</ul>
    </div>)}
  </section>;
}
