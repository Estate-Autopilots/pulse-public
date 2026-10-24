"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ExternalLink, FileText, Pencil, RotateCcw, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { day } from "../lib/format";
import { post } from "../records";
import { styles } from "../ui";
import { Confidence, plural } from "./parts";
import { KIND_LABEL, type Source } from "./types";
import css from "./sops.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** One Drive document: where it is, why Pulse thinks it is an SOP, and each SOP it reads as (with its confidence). */
export function SourceCard({ s, detail }: { s: Source; detail?: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function run(path: string, body: Record<string, unknown>, ok: string, go?: (r: Record<string, unknown>) => string) {
    setBusy(true); try { const r = await post(path, body); notify({ id: "sop-drive", tone: "success", title: ok, timeout: 3000 }); if (go) router.push(go(r)); else router.refresh(); }
    catch (e) { notify({ id: "sop-drive", tone: "error", title: "Not done", message: msg(e) }); } finally { setBusy(false); }
  }
  return <li className={css.source}>
    <div className={css.sourceHead}><FileText size={18} aria-hidden="true" />
      <div><h3>{detail ? s.name : <Link href={`/sops/drive/${s.id}`}>{s.name}</Link>}</h3><small title={s.path ?? undefined}>{[s.path, s.owner ? `shared by ${s.owner}` : null, s.modifiedAt ? `changed ${day(s.modifiedAt)}` : null].filter(Boolean).join(" · ")}</small></div>
      <span className={css.partActions}>{s.link ? <a className={`${styles.btn} ${styles.btnSmall}`} href={s.link} target="_blank" rel="noreferrer">Open in Drive<ExternalLink size={12} aria-hidden="true" /></a> : null}
        {s.status === "new" || s.status === "gone" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void run(`sops/drive/${s.id}/dismiss`, {}, "Marked as not an SOP")}><X size={13} aria-hidden="true" />Not an SOP</button> : null}
        {s.status === "dismissed" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void run(`sops/drive/${s.id}/restore`, {}, "Back in the waiting list")}><RotateCcw size={13} aria-hidden="true" />It is one</button> : null}</span>
    </div>
    {s.reasons.length ? <p className={css.reasons}>Why: {s.reasons.join(" · ")}</p> : null}
    {s.parts.length ? s.parts.map((p) => <div key={p.index} className={css.part}>
      <h4>{p.title}<Confidence value={p.confidence} words={p.confidenceWords} />{p.done ? <Link className={css.chip} href={`/sops/${p.done}`}>Brought in ✓</Link> : null}</h4>
      <span className={css.partActions}>{p.done ? <Link className={`${styles.btn} ${styles.btnSmall}`} href={`/sops/${p.done}`}>Open the SOP</Link> : s.status !== "dismissed" ? <>
        <Link className={`${styles.btn} ${styles.btnSmall}`} href={`/sops/new?source=${s.id}&part=${p.index}`}><Pencil size={13} aria-hidden="true" />Edit first</Link>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy} onClick={() => void run(`sops/drive/${s.id}/import`, { part: p.index }, `“${p.title}” is an SOP now`, (r) => `/sops/${r.id}`)}><Check size={13} aria-hidden="true" />Bring in</button></> : null}</span>
      <p className={css.evidence}>{[plural(p.steps, "step"), p.roles.length ? `${p.roles.slice(0, 4).join(", ")}${p.roles.length > 4 ? "…" : ""}` : null, p.handoffs ? plural(p.handoffs, "handoff") : null].filter(Boolean).join(" · ")}. {p.evidence.slice(1).filter((e) => !e.startsWith("Roles:")).join(" · ")}</p>
      <ol>{p.preview.map((x, i) => <li key={i} title={[x.title, x.role, x.kind !== "task" ? KIND_LABEL[x.kind] : null].filter(Boolean).join(" · ")}><span>{x.title}</span>{x.role ? <small>· {x.role}</small> : null}{x.kind !== "task" ? <small>· {KIND_LABEL[x.kind]}</small> : null}</li>)}{p.steps > p.preview.length ? <li>… {p.steps - p.preview.length} more</li> : null}</ol>
    </div>) : <p className={css.hint}>Pulse found no steps it could read in this document. Open it in Drive, or paste its text into a new SOP.</p>}
  </li>;
}
