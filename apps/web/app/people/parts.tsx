"use client";

import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { PersonLink } from "../lib/api";
import { userId } from "../lib/format";
import { Avatar } from "../ui";
import css from "./people.module.css";
import { useOrgCode } from "../org-code";

/** The employee ID as a button that copies it. */
export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(id); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch {} }
  return <button type="button" className={css.copyId} onClick={copy} title="Copy the employee ID" aria-label={`Employee ID ${id}. Copy`}>
    <b>{id}</b>{copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}<span className={css.copied} role="status">{copied ? "Copied" : ""}</span>
  </button>;
}

/** The reporting line as a small tree: managers from the top down, this person, then their direct reports. */
export function ReportingLine({ managers, person, reports }: { managers: PersonLink[]; person: PersonLink; reports: PersonLink[] }) {
  const orgCode = useOrgCode();
  const above = [...managers].reverse();
  const node = (m: PersonLink, depth: number, self?: boolean) => (
    <li key={m.id} className={css.treeRow} data-self={self ? "" : undefined} style={{ paddingLeft: 14 + depth * 22 }}>
      {depth ? <span className={css.treeElbow} aria-hidden="true" /> : null}
      <Avatar name={m.name} id={m.id} photoAt={m.photoAt} size={26} />
      <span className={css.treeText}>{self ? <b>{m.name}</b> : <Link href={`/people/${m.id}`}>{m.name}</Link>}<small>{[m.role, userId(m.userNo, orgCode)].filter(Boolean).join(" · ")}</small></span>
      {self ? <span className={css.treeNote}>This profile</span> : null}
    </li>
  );
  return <ul className={css.tree}>
    {above.map((m, i) => node(m, i))}
    {node(person, above.length, true)}
    {reports.map((m) => node(m, above.length + 1))}
  </ul>;
}
