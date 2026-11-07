"use client";
// DOCS-WORKBENCH: "Docs that mention this" on a task's (and any mentionable thing's) page: the docs the viewer can see
// whose words mention it (pulse.doc_mention under the docs' own row security).
import Link from "next/link";
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import css from "./docs.module.css";

type Doc = { id: string; title: string; updatedBy: string | null };
export function DocsMentioning({ kind, id, className }: { kind: "task" | "project" | "goal" | "contract" | "client" | "person" | "agent" | "doc" | "file"; id: string; className?: string }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  useEffect(() => {
    let gone = false;
    void fetch(`/api/v0/docs/backlinks?kind=${kind}&id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { docs: [] })
      .then((d) => { if (!gone) setDocs(d.docs ?? []); }).catch(() => { if (!gone) setDocs([]); });
    return () => { gone = true; };
  }, [kind, id]);
  if (!docs?.length) return null;
  return <section className={className} aria-label="Docs that mention this">
    <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>Docs that mention this</h2>
    <div className={css.backlinks}>{docs.map((d) => <Link key={d.id} href={`/docs/${d.id}`}><FileText size={15} aria-hidden="true" />{d.title}</Link>)}</div>
  </section>;
}
