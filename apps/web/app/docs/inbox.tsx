"use client";
// DOCS-INTERACTIVE: the top of Docs. "Waiting for you": docs people (and AI employees) sent you to read, approve or
// review. "Sent": what you sent, each with its answer and how much was read. Admins switch reading receipts on or off.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Eye, Inbox, Send } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Switch } from "../kit";
import { post } from "../orgs/client";
import { ASK_WORDS, STATUS_WORDS, type DocRequest } from "./interactive-panels";
import { when } from "./workbench";
import css from "./docs.module.css";

type Sent = DocRequest & { reads?: string };
export function DocsInbox() {
  const [data, setData] = useState<{ waiting: DocRequest[]; sent: Sent[] } | null>(null);
  useEffect(() => {
    void fetch("/api/v0/docs/inbox", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => { if (d) setData(d); }).catch(() => undefined);
  }, []);
  const waiting = (data?.waiting ?? []).filter((r) => r.status === "waiting");
  const sent = (data?.sent ?? []).slice(0, 8);
  return <>
    {waiting.length ? <section aria-label="Waiting for you" className={css.inbox}>
      <div className={css.sectionHead}><h2><Inbox size={15} aria-hidden="true" /> Waiting for you</h2><span className={css.hint}>{waiting.length}</span></div>
      <ul className={css.list}>{waiting.map((r) => <li key={r.id}>
        <div className={css.itemText}>
          <Link href={`/docs/${r.docId}?request=${r.id}`}>{r.title}</Link>
          <span>{r.from} asks you to {ASK_WORDS[r.ask]} it · {when(r.sentAt)}{r.dueAt ? ` · needed by ${when(r.dueAt)}` : ""}</span>
        </div>
        <span className={css.state} data-state="waiting">{r.ask === "approve" ? "Approve" : r.ask === "review" ? "Review" : "Read"}</span>
      </li>)}</ul>
    </section> : null}
    {sent.length ? <section aria-label="Sent" className={css.inbox}>
      <div className={css.sectionHead}><h2><Send size={15} aria-hidden="true" /> Sent</h2></div>
      <ul className={css.list}>{sent.map((r) => <li key={r.id}>
        <div className={css.itemText}>
          <Link href={`/docs/${r.docId}?reads=1`}>{r.title}</Link>
          <span>To {r.to} · {ASK_WORDS[r.ask]} · {when(r.sentAt)}{r.reads ? ` · ${r.reads}` : ""}</span>
        </div>
        <span className={css.state} data-state={r.status}>{STATUS_WORDS[r.status] ?? r.status}</span>
      </li>)}</ul>
    </section> : null}
  </>;
}

/** FIX-DOCS-WORK (owner walkthrough, 10 Nov 2026: "something stays selected that I never selected"): reading receipts are
 *  a company setting, so they are a switch in the folder panel (admins only), not a ticked box above the files, where it
 *  looked like a doc someone had picked. */
export function ReceiptsSetting({ initial }: { initial: { docReads: boolean; canChange: boolean } }) {
  // The page brings the setting with it (admins only), so the switch is there on the first paint.
  const [setting, setSetting] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (!setting.canChange) return null;
  const change = (on: boolean) => {
    setBusy(true);
    void post<{ docReads: boolean; canChange: boolean }>("docs/settings", { docReads: on })
      .then((s) => { setSetting(s); notify({ id: "docs-receipts", tone: "success", title: on ? "Reading receipts are on" : "Reading receipts are off", message: on ? "Senders see how much of a doc was read." : "Nobody sees how much was read.", timeout: 3500 }); })
      .catch(() => notify({ id: "docs-receipts", tone: "error", title: "Not changed", message: "Try again.", timeout: 5000 }))
      .finally(() => setBusy(false));
  };
  return <div className={css.setting} aria-label="Docs settings">
    <p className={css.settingHead}><Eye size={14} aria-hidden="true" />For the whole company</p>
    <Switch label="Reading receipts" hint="Senders see how much of a doc was read." states={["On", "Off"]} checked={setting.docReads} disabled={busy} onChange={change} />
  </div>;
}
