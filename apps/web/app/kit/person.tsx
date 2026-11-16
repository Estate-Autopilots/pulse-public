"use client";
// TASKS-4A kit: people as people. Avatar (the one in ui.tsx: photo, or initials on a colour fixed by the name), a person
// chip (LinkedIn-style: photo and name, optionally a link or removable) and a stack of faces with "+3".
import Link from "next/link";
import type { CSSProperties } from "react";
import { X } from "lucide-react";
import { Avatar } from "../ui";
import { Tooltip } from "./popover";
import css from "./kit.module.css";

export { Avatar };
export type PersonLike = { id: string; name: string; photoAt?: string | null; agent?: boolean; employeeId?: string | null };
const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];

/** A person as a chip: face and name. `short` shows the first name only (the full name stays in the tooltip). */
export function PersonChip({ person, size = "md", short, href, onRemove, tone, me, className }: { person: PersonLike; size?: "sm" | "md"; short?: boolean; href?: string;
  onRemove?: () => void; tone?: "accent"; me?: string | null; className?: string }) {
  const name = person.id === me ? "Me" : short ? first(person.name) : person.name;
  const body = <><Avatar ai={person.agent} name={person.name} id={person.id} photoAt={person.photoAt ?? null} size={size === "sm" ? 16 : 20} /><span className={css.personName}>{name}</span>
    {onRemove ? <button type="button" className={css.personX} aria-label={`Remove ${person.name}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}><X size={12} aria-hidden="true" /></button> : null}</>;
  const cls = `${css.person}${className ? ` ${className}` : ""}`;
  const chip = href ? <Link href={href} className={cls} data-size={size} data-tone={tone}>{body}</Link> : <span className={cls} data-size={size} data-tone={tone}>{body}</span>;
  return name !== person.name ? <Tooltip content={person.name}>{chip}</Tooltip> : chip;
}

/** Up to `max` faces, overlapping, then "+n"; every name is in the label. */
export function AvatarStack({ people, max = 4, size = 24, label }: { people: PersonLike[]; max?: number; size?: number; label?: string }) {
  const shown = people.slice(0, max), more = people.length - shown.length;
  const names = people.map((p) => p.name).join(", ");
  return <Tooltip content={names || "Nobody"}><span className={css.stack} role="img" aria-label={label ? `${label}: ${names}` : names}>
    {shown.map((p) => <Avatar key={p.id} ai={p.agent} name={p.name} id={p.id} photoAt={p.photoAt ?? null} size={size} />)}
    {more > 0 ? <span className={css.stackMore} style={{ "--size": `${size}px` } as CSSProperties}>+{more}</span> : null}
  </span></Tooltip>;
}
