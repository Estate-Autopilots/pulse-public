"use client";
// DOCS-WORKBENCH: "Docs that mention this" on a task's (and any mentionable thing's) page: the docs the viewer can see
// whose words mention it (pulse.doc_mention under the docs' own row security).
// DOCS-INTERACTIVE: for a task, project or goal this is its "Docs": the docs linked to it (its brief first) and the ones
// that mention it, plus "Write a brief", which makes a brief doc already linked to it (one knowledge base, both ways).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FilePlus2, FileText } from "lucide-react";
import { post } from "../orgs/client";
import css from "./docs.module.css";

type Doc = { id: string; title: string; updatedBy: string | null; role?: string | null };
export function DocsMentioning({ kind, id, className }: { kind: "task" | "project" | "goal" | "contract" | "client" | "person" | "agent" | "doc" | "file"; id: string; className?: string }) {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const work = kind === "task" || kind === "project" || kind === "goal";
  useEffect(() => {
    let gone = false;
    void fetch(`/api/v0/docs/backlinks?kind=${kind}&id=${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { docs: [] })
      .then((d) => { if (!gone) setDocs(d.docs ?? []); }).catch(() => { if (!gone) setDocs([]); });
    return () => { gone = true; };
  }, [kind, id]);
  async function brief() {
    setBusy(true); setError(null);
    try { const r = await post<{ id: string }>("docs/brief", { kind, id }); router.push(`/docs/${r.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); setBusy(false); }
  }
  if (!work && !docs?.length) return null;
  const hasBrief = docs?.some((d) => d.role === "brief");
  return <section className={className} aria-label={work ? "Docs" : "Docs that mention this"}>
    <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>{work ? "Docs" : "Docs that mention this"}</h2>
    <div className={css.backlinks}>
      {docs?.map((d) => <Link key={d.id} href={`/docs/${d.id}`}><FileText size={15} aria-hidden="true" />{d.title}{d.role === "brief" ? <span className={css.state} data-state="approved">Brief</span> : null}</Link>)}
      {work && docs && !docs.length ? <p className={css.hint} style={{ margin: 0 }}>No docs yet.</p> : null}
      {work && docs && !hasBrief ? <button type="button" className={`${css.btn} ${css.small}`} style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void brief()}>
        <FilePlus2 size={15} aria-hidden="true" />{busy ? "Opening…" : "Write a brief"}</button> : null}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div>
  </section>;
}
