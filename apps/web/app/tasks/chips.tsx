// TASKS-P0: small parts every task screen shares: a project's colour and icon, urgency in words and colour, the
// people around a task as a row of avatars. No hooks, so server and client components both use them.
import Link from "next/link";
import { Briefcase, Building2, Calendar, Clapperboard, Clock, Code, Folder, GraduationCap, Heart, Megaphone, Package, Rocket, Shield, Sparkles, Users, Wallet, Wrench, type LucideIcon } from "lucide-react";
import { Avatar } from "../ui";
import { urgency } from "../lib/task-sense.mjs";
import { STATUS } from "./parts";
import css from "./focus.module.css";

export const PROJECT_ICONS: Record<string, LucideIcon> = { folder: Folder, briefcase: Briefcase, rocket: Rocket, wallet: Wallet, users: Users, clapperboard: Clapperboard, code: Code,
  megaphone: Megaphone, building: Building2, heart: Heart, sparkles: Sparkles, shield: Shield, wrench: Wrench, calendar: Calendar, "graduation-cap": GraduationCap, package: Package };
export const PROJECT_COLORS = ["slate", "blue", "teal", "green", "amber", "orange", "red", "pink", "violet", "indigo"] as const;

/** The project a task belongs to, in its colour with its icon. */
export function ProjectChip({ id, name, color, icon, category, link = true }: { id: string | null; name: string | null; color?: string | null; icon?: string | null; category?: string | null; link?: boolean }) {
  if (!name) return null;
  const Icon = PROJECT_ICONS[icon ?? ""] ?? Folder;
  const body = <><Icon size={12} aria-hidden="true" /><span>{name}</span></>;
  const title = category ? `${name} · ${category}` : name;
  return link && id ? <Link className={`${css.proj} ${css.projChip}`} data-color={color ?? undefined} href={`/tasks/projects/${id}`} title={title}>{body}</Link>
    : <span className={`${css.proj} ${css.projChip}`} data-color={color ?? undefined} title={title}>{body}</span>;
}
/** Just the icon, in the project's colour (cards). */
export function ProjectDot({ name, color, icon }: { name: string | null; color?: string | null; icon?: string | null }) {
  if (!name) return null;
  const Icon = PROJECT_ICONS[icon ?? ""] ?? Folder;
  return <span className={`${css.proj} ${css.projDot}`} data-color={color ?? undefined} title={name} aria-label={`Project: ${name}`} role="img"><Icon size={12} aria-hidden="true" /></span>;
}

export function UrgencyChip({ task, now, short }: { task: { status: string; dueAt?: string | null; dueOn?: string | null }; now?: number; short?: boolean }) {
  const u = urgency(task, now);
  if (u.key === "done") return null;
  return <span className={css.urgency} data-tone={u.tone} title={u.text}><Clock size={13} aria-hidden="true" />{short ? u.short : u.text}</span>;
}

export function StatusChip({ status }: { status: string }) {
  const st = STATUS[status] ?? STATUS.unknown;
  return <span className={css.statusChip} data-tone={st.tone}>{st.label}</span>;
}

/** People as overlapping avatars, the rest as "+n". */
export function AvatarStack({ people, size = 22, max = 4 }: { people: { id: string | null; name: string | null; photoAt?: string | null }[]; size?: number; max?: number }) {
  const seen = new Set<string>(); const list = people.filter((p) => p.name && !seen.has(p.id ?? p.name) && seen.add(p.id ?? p.name!));
  if (!list.length) return null;
  return <span className={css.stack} aria-label={list.map((p) => p.name).join(", ")} role="img">
    {list.slice(0, max).map((p) => <span key={p.id ?? p.name} title={p.name!}><Avatar name={p.name!} id={p.id ?? undefined} photoAt={p.photoAt ?? null} size={size} /></span>)}
    {list.length > max ? <span className={css.more}>+{list.length - max}</span> : null}
  </span>;
}

/** Who may open a protected document on a task, in words. */
export function protectedFor(p: { kind: string; concerns?: string | null }) {
  return p.kind === "document" ? `Protected: HR, the founders and ${p.concerns ?? "the person it concerns"} can see it` : null;
}
