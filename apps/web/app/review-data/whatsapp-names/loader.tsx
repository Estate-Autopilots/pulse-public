"use client";
// EST-1542 (B, Pulse CEO on EST-1520): load the names from WhatsApp exports on this computer. The files are read here
// with Pulse's own reader (@pulse/chat-export, the one the chat import uses); only each sender's name and how many
// messages and groups they have are sent. Message text and phone numbers never leave the device, and a load never
// changes an answer already given (0640 chat_names_load).
import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";
import { FileText, FolderOpen, Upload } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { decodeExport, parseWhatsAppExport } from "@pulse/chat-export";
import { post } from "../../records";
import { Panel, styles } from "../../ui";
import { exportGroup, senderTotals, type SenderRow } from "../../lib/chat-names.mjs";
import css from "./names.module.css";

const MAX = 2000;
type Read = { names: SenderRow[]; phoneSenders: number; files: number; groups: number; failed: number };

export function Loader({ source, empty }: { source: string; empty: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(""), [read, setRead] = useState<Read | null>(null);
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])].filter((f) => /\.txt$/i.test(f.name));
    e.target.value = "";
    if (!files.length) { notify({ id: "names-load", tone: "error", title: "No WhatsApp exports there", message: "Choose the .txt files WhatsApp made, or the folder that holds them." }); return; }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone, parsed: { group: string; participants: { label: string; phone: boolean; messages: number }[] }[] = [];
    let failed = 0;
    for (const [i, f] of files.entries()) {
      setBusy(`Reading ${i + 1} of ${files.length}`);
      try {
        const r = parseWhatsAppExport(decodeExport(new Uint8Array(await f.arrayBuffer())), { timeZone: zone });
        parsed.push({ group: exportGroup(f.name, f.webkitRelativePath), participants: r.participants });
      } catch { failed += 1; }
    }
    setRead({ ...senderTotals(parsed), files: files.length, groups: new Set(parsed.map((p) => p.group)).size, failed });
    setBusy("");
  }
  async function load() {
    if (!read || busy) return;
    setBusy("Loading");
    try {
      const r = await post<{ added: number; updated: number }>("chat-names/load", { source, names: read.names.slice(0, MAX) });
      notify({ id: "names-load", tone: "success", title: `${r.added} names added, ${r.updated} updated`, timeout: 4000 });
      setRead(null); router.refresh();
    } catch (err) { notify({ id: "names-load", tone: "error", title: "Not loaded", message: err instanceof Error ? err.message : "Try again" }); }
    finally { setBusy(""); }
  }
  const count = read ? Math.min(read.names.length, MAX) : 0;
  return <Panel title="Load names from WhatsApp exports" sub={empty ? "Start here" : "Add names from more exports"}>
    <div className={css.load}>
      <p className={css.note}>Choose the chat exports on this computer (the .txt files WhatsApp makes), or the folder that holds them. They are read here: only each sender&apos;s name and how many messages and groups they have are sent. Message text and phone numbers never leave this computer, and answers already given never change.</p>
      <div className={css.loadActions}>
        <label className={`${styles.btn} ${css.pick}`} aria-disabled={!!busy}><FileText size={15} aria-hidden="true" />Choose files
          <input className={css.srOnly} type="file" accept=".txt,text/plain" multiple disabled={!!busy} onChange={(e) => void pick(e)} /></label>
        <label className={`${styles.btn} ${css.pick}`} aria-disabled={!!busy}><FolderOpen size={15} aria-hidden="true" />Choose a folder
          <input className={css.srOnly} type="file" multiple disabled={!!busy} ref={(el) => { el?.setAttribute("webkitdirectory", ""); }} onChange={(e) => void pick(e)} /></label>
      </div>
      {busy ? <p className={css.note} role="status">{busy}…</p> : null}
      {read && !busy ? <div className={css.loadResult} role="status">
        <p><b>{read.names.length.toLocaleString("en-IN")} names</b> from {read.groups.toLocaleString("en-IN")} group{read.groups === 1 ? "" : "s"} in {read.files.toLocaleString("en-IN")} file{read.files === 1 ? "" : "s"}
          {read.phoneSenders ? `; ${read.phoneSenders} phone number${read.phoneSenders === 1 ? "" : "s"} left out` : ""}{read.failed ? `; ${read.failed} file${read.failed === 1 ? "" : "s"} could not be read` : ""}.
          {read.names.length > MAX ? ` The ${MAX} most used are loaded.` : ""}</p>
        <div className={css.loadActions}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!count} onClick={() => void load()}><Upload size={15} aria-hidden="true" />Load {count.toLocaleString("en-IN")} names</button>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setRead(null)}>Cancel</button>
        </div>
      </div> : null}
    </div>
  </Panel>;
}
