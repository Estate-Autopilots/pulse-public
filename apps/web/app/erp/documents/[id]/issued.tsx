"use client";

// Billing redesign (18 Oct 2026, the blueprint's "One next step"): an approved (numbered) document. The chain bar links
// the quotation, proforma and tax invoice made from one another; one main button does the next step for its state:
// Send on WhatsApp → Log reply → Make proforma → Make tax invoice → Record payment. Everything else (downloads, mark
// sent, an acceptance link, a credit note, cancel) is in the quiet "…" menu. Sending shares the filed PDF through the
// phone's share sheet (or WhatsApp with the acceptance link on a computer); only an explicit "Mark sent" records that it
// was handed over. The preview is the filed PDF. EST-1239's follow-up card (followup.tsx, on its own branch) goes in the
// follow-up slot below; "Log reply" then opens its answer panel, and until it is there it records accepted or declined.
// EST-1237: a conversion runs once at a time (the menu too), and a browser that can't hand a file to another app gets the
// PDF downloaded with plain instructions; WhatsApp with the acceptance link opens only when the person asks for it.
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Ban, CheckCheck, Copy, Download, Eye, FileMinus2, FileOutput, Link2, MessageSquareReply, MoreHorizontal, Send, Wallet, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { DOC_LABELS, formatAmount, formatDate, toPaise } from "@pulse/invoice-doc/browser";
import { post } from "../../../records";
import { Badge, styles } from "../../../ui";
import { Drawer, DrawerFooter, DrawerSection, useIsPhone } from "../../../kit/drawer";
import { Disclosure } from "../../../kit/disclosure";
import { LineList, LineRow } from "../../../kit/line-row";
import { ChainBar, NextStep } from "../../../kit/next-step";
import { Menu, type MenuItem } from "../../../kit/menu";
import { PdfPages } from "../../preview";
import { QuoteFollowUp } from "../../followup";
import { STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from "../../nav";
import type { Doc, DocumentData } from "../../types";
import { chainSteps, EVENT, inr, when } from "../chain";
import css from "../documents.module.css";
import { DateField } from "../../../kit/date-field";
import { PortalShare } from "../portal-share";
import { SelectField } from "../../../kit/select-field";

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
type Pay = { receivedOn: string; amount: number; tds: number; method: string; reference: string; bankLineKey: string | null };
type Next = { label: string; icon: ReactNode; run: () => void; status: string } | null;
/** WhatsApp wants the number with its country code and no "+": a 10-digit Indian mobile gets 91. */
const waNumber = (phone?: string | null) => { const n = (phone ?? "").replace(/\D/g, ""); return n.length === 10 ? `91${n}` : n.length >= 11 ? n : ""; };

export function IssuedDocument({ data, zone }: { data: DocumentData; zone: string }) {
  const router = useRouter();
  const phone = useIsPhone();
  const d = data.document, label = DOC_LABELS[d.docType];
  // The filed PDF for this document and status: the preview draws `bytes`, "Send on WhatsApp" shares `file` (EST-2101).
  const [pdf, setPdf] = useState<{ key: string; bytes: Uint8Array; file: File } | null>(null);
  // One action at a time: a tap (the main button, or the same step from the menu) while one is still answering does
  // nothing, so a conversion never makes two drafts. React renders `busy` before the next tap's event.
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState<Pay | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [reply, setReply] = useState(false), [preview, setPreview] = useState(false), [shared, setShared] = useState(false), [manual, setManual] = useState(false);
  const balance = d.total - d.paid - d.credited;
  const key = `${d.id}:${d.status}`, fileName = `${(d.number ?? "document").replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
  useEffect(() => {
    let gone = false;
    fetch(`/api/v0/erp/documents/${d.id}/pdf?inline=1`).then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => { if (!gone && b) setPdf({ key, bytes: new Uint8Array(b), file: new File([b], fileName, { type: "application/pdf" }) }); }).catch(() => undefined);
    return () => { gone = true; };
  }, [d.id, key, fileName]);
  async function act(path: string, body: unknown, done: string, go?: (r: Record<string, unknown>) => string | null) {
    if (busy) return null;
    setBusy(true);
    try { const r = await post<Record<string, unknown>>(path, body); notify({ id: "erp-act", tone: "success", title: done, timeout: 3500 }); const to = go?.(r); if (to) router.push(to); else router.refresh(); return r; }
    catch (e) { notify({ id: "erp-act", tone: "error", title: "Not done", message: message(e) }); return null; } finally { setBusy(false); }
  }
  const w = data.canWrite;
  const open = (r: Doc) => router.push(`/erp/documents/${r.id}`);
  const madeFrom = (type: string) => data.related.find((r) => r.sourceId === d.id && r.docType === type && r.status !== "cancelled");
  /** The next document in the chain; one already made from this is opened instead of making a second. */
  const make = (type: "proforma" | "invoice") => {
    const has = madeFrom(type);
    if (has) return open(has);
    void act("erp/documents", { docType: type, sourceId: d.id }, `${type === "proforma" ? "Proforma" : "Tax invoice"} draft made: client, lines and terms carried over`, (r) => `/erp/documents/${r.id}`);
  };
  async function acceptanceLink() {
    const r = await post<{ url: string }>(`erp/documents/${d.id}/link`, { days: 30 });
    return r.url;
  }
  const text = `${label.title} ${d.number} from ${d.seller?.tradeName || d.seller?.legalName || "us"}: ${inr(d.total)}`;
  const shareable = (file: File) => typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  /** Shares the filed PDF through the phone's share sheet (WhatsApp is one tap there). A browser that can't share files
   *  downloads it and says how to attach it. Cancelling sends nothing, and nothing is marked sent until someone says so.
   *  EST-2101: Chrome and Safari allow a share only for about 5 s after the tap, so the copy the page already holds goes
   *  to the sheet with nothing awaited in between. Only before it has arrived does the tap fetch the PDF itself. */
  async function send() {
    if (busy) return;
    const ready = pdf?.key === key && shareable(pdf.file) ? pdf.file : null;
    setBusy(true);
    try {
      const file = ready ?? await (async () => {
        const r = await fetch(`/api/v0/erp/documents/${d.id}/pdf`);
        if (!r.ok) throw new Error("The PDF could not be prepared. Try again.");
        return new File([await r.blob()], fileName, { type: "application/pdf" });
      })();
      if (shareable(file)) {
        await navigator.share({ files: [file], title: `${label.title} ${d.number}`, text });
      } else {
        const a = document.createElement("a"), href = URL.createObjectURL(file);
        a.href = href; a.download = file.name; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 60000);
        setManual(true);
      }
      setShared(true);
    } catch (e) {
      const late = !ready && e instanceof DOMException && e.name === "NotAllowedError"; // the PDF arrived after the tap's share window
      if (!(e instanceof DOMException && e.name === "AbortError")) notify({ id: "erp-share", tone: "error", title: "Not shared", message: late ? "The PDF took a while to arrive. Tap Send on WhatsApp again." : message(e) });
    } finally { setBusy(false); }
  }
  /** On a computer: WhatsApp with the message and, for a quotation, proforma or invoice, an acceptance link. Only on a tap. */
  async function openWhatsApp() {
    const url = d.docType !== "credit_note" ? await acceptanceLink().catch(() => null) : null;
    window.open(`https://wa.me/${waNumber(d.buyer?.phone)}?text=${encodeURIComponent(url ? `${text}\nSee it and accept: ${url}` : text)}`, "_blank", "noopener");
    if (url) setLink(url);
  }
  const markSent = () => act(`erp/documents/${d.id}/mark`, { action: "sent" }, d.docType === "quotation" ? "Marked sent: the follow-up starts" : "Marked sent");
  /** Log reply: the follow-up's own answer panel when its card is in the slot (EST-1239), else accepted / declined. */
  const logReply = () => {
    const button = [...(document.querySelector("[data-followup-slot]")?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Log reply"));
    if (button) button.click(); else setReply(true);
  };
  const download = (format: "pdf" | "docx") => { const a = document.createElement("a"); a.href = `/api/v0/erp/documents/${d.id}/${format}`; a.download = ""; document.body.append(a); a.click(); a.remove(); };
  const startPay = () => setPay({ receivedOn: data.today, amount: Math.max(0, balance), tds: 0, method: "bank", reference: "", bankLineKey: null });
  const cancel = () => { const note = window.prompt(`Why is ${d.number} cancelled? (kept in the log)`); if (note) void act(`erp/documents/${d.id}/mark`, { action: "cancel", note }, `${label.title} cancelled`); };

  const openInvoice = d.docType === "invoice" && ["issued", "sent", "part_paid"].includes(d.status);
  const convertible = ["quotation", "proforma"].includes(d.docType) && ["issued", "sent", "accepted"].includes(d.status);
  const later = madeFrom;
  const next: Next = !w || d.status === "cancelled" ? null
    : shared && d.status === "issued" ? { label: "Mark sent", icon: <CheckCheck size={15} aria-hidden="true" />, run: () => void markSent(), status: `Shared. Once it is with the customer, mark it sent${d.docType === "quotation" ? ": the follow-up starts then" : ""}.` }
    : d.status === "issued" ? { label: "Send on WhatsApp", icon: <Send size={15} aria-hidden="true" />, run: () => void send(), status: `Approved ${formatDate(d.issuedAt?.slice(0, 10) ?? d.issueDate)}. Send it to the customer next.` }
    : d.docType === "quotation" && d.status === "sent" ? { label: "Log reply", icon: <MessageSquareReply size={15} aria-hidden="true" />, run: logReply, status: "With the customer: log their answer when they reply." }
    : d.docType === "quotation" && d.status === "accepted" ? { label: later("proforma") ? "Open the proforma" : "Make proforma", icon: <FileOutput size={15} aria-hidden="true" />, run: () => make("proforma"), status: "The customer agreed. Client, lines and terms carry over; nothing is retyped." }
    : d.docType === "proforma" && ["sent", "accepted"].includes(d.status) ? { label: later("invoice") ? "Open the tax invoice" : "Make tax invoice", icon: <FileOutput size={15} aria-hidden="true" />, run: () => make("invoice"), status: "When the advance is in, the tax invoice carries everything over." }
    : d.status === "converted" ? (() => { const t = later("invoice") ?? later("proforma") ?? data.related.find((r) => r.sourceId === d.id); return t ? { label: `Open the ${TYPE_LABEL[t.docType].toLowerCase()}`, icon: <FileOutput size={15} aria-hidden="true" />, run: () => open(t), status: `Converted into ${TYPE_LABEL[t.docType].toLowerCase()} ${t.number ?? "draft"}.` } : null; })()
    : openInvoice ? { label: "Record payment", icon: <Wallet size={15} aria-hidden="true" />, run: startPay, status: `${inr(Math.max(0, balance))} to collect${d.dueDate ? ` · due ${formatDate(d.dueDate)}` : ""}${d.dueDate && d.dueDate < data.today ? " (overdue)" : ""}.` }
    : null;
  const idle = d.status === "cancelled" ? `Cancelled ${formatDate(d.cancelledAt)}: ${d.cancelReason ?? ""}` : d.status === "paid" ? "Paid in full." : d.status === "declined" ? "The customer declined it." : !w ? "Read only." : "Nothing more to do.";

  const menu: MenuItem[] = [
    { key: "pdf", label: "Download PDF", icon: <Download size={15} aria-hidden="true" />, onSelect: () => download("pdf") },
    { key: "docx", label: "Download Word file", icon: <Download size={15} aria-hidden="true" />, onSelect: () => download("docx") },
    ...(w && d.status !== "cancelled" && next?.label !== "Send on WhatsApp" && d.status !== "converted" ? [{ key: "share", label: "Send on WhatsApp", icon: <Send size={15} aria-hidden="true" />, onSelect: () => void send() }] : []),
    ...(w && d.status === "issued" && next?.label !== "Mark sent" ? [{ key: "sent", label: "Mark sent", hint: "It was handed to the customer", icon: <CheckCheck size={15} aria-hidden="true" />, onSelect: () => void markSent() }] : []),
    ...(w && ["quotation", "proforma"].includes(d.docType) && ["issued", "sent"].includes(d.status) ? [
      { key: "acc", label: "Customer accepted", icon: <CheckCheck size={15} aria-hidden="true" />, onSelect: () => void act(`erp/documents/${d.id}/mark`, { action: "accepted", note: "Recorded in Pulse" }, "Marked accepted") },
      { key: "dec", label: "Customer declined", icon: <X size={15} aria-hidden="true" />, onSelect: () => { const note = window.prompt("What did the customer say? (kept in the log)"); if (note !== null) void act(`erp/documents/${d.id}/mark`, { action: "declined", note: note || "Declined" }, "Marked declined"); } }] : []),
    ...(w && convertible && d.docType === "quotation" && !next?.label.includes("proforma") ? [{ key: "pro", label: later("proforma") ? "Open the proforma" : "Make proforma", icon: <FileOutput size={15} aria-hidden="true" />, onSelect: () => make("proforma") }] : []),
    ...(w && convertible && !next?.label.includes("tax invoice") ? [{ key: "inv", label: later("invoice") ? "Open the tax invoice" : "Make tax invoice", icon: <FileOutput size={15} aria-hidden="true" />, onSelect: () => make("invoice") }] : []),
    ...(w && openInvoice && next?.label !== "Record payment" ? [{ key: "pay", label: "Record payment", icon: <Wallet size={15} aria-hidden="true" />, onSelect: startPay }] : []),
    ...(w && ["quotation", "proforma", "invoice"].includes(d.docType) && ["issued", "sent", "part_paid", "paid"].includes(d.status) ? [{ key: "link", label: "Make an acceptance link", hint: "Shown once; you share it", icon: <Link2 size={15} aria-hidden="true" />,
      onSelect: () => void acceptanceLink().then(setLink).catch((e) => notify({ id: "erp-link", tone: "error", title: "No link", message: message(e) })) }] : []),
    ...(w && d.docType === "invoice" && ["issued", "sent", "part_paid", "paid"].includes(d.status) && d.credited < d.total ? [{ key: "cn", label: "Credit note", icon: <FileMinus2 size={15} aria-hidden="true" />,
      onSelect: () => void act("erp/documents", { docType: "credit_note", againstId: d.id }, "Credit note draft made", (r) => `/erp/documents/${r.id}`) }] : []),
    ...(w && !["cancelled", "converted", "paid", "part_paid"].includes(d.status) && !(d.docType === "invoice" && d.credited) ? [{ key: "cancel", label: `Cancel ${label.noun}`, icon: <Ban size={15} aria-hidden="true" />, danger: true, separator: true, onSelect: cancel }] : []),
  ];
  const more = <Menu label="More actions" items={menu} className={css.more} buttonLabel="More actions"><MoreHorizontal size={16} aria-hidden="true" /></Menu>;
  const main = next ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={next.run}>{next.icon}{next.label}</button> : null;
  const activity = <>
    <ol className={css.activity}>{data.events.map((e, i) => <li key={i}><b>{EVENT[e.kind] ?? e.kind}</b><span>{when(e.at)}{e.actor ? ` · ${e.actor}` : e.kind.startsWith("client") || e.kind === "link_opened" ? " · customer" : ""}</span></li>)}</ol>
    {/* CLIENT-PORTAL: the document in the client's own Pulse space. */}
    <PortalShare id={d.id} issued={["issued", "sent", "part_paid", "paid", "accepted"].includes(d.status)} canWrite={!!w} />
    {data.links.length ? <p className={css.note}>Acceptance links: {data.links.map((l) => `${formatDate(l.createdAt)} (${l.decision ? `${l.decision} by ${l.signer}` : l.revokedAt ? "replaced" : l.openedAt ? "opened" : "not opened"})`).join(", ")}</p> : null}
    {data.file ? <p className={css.note}>Filed copy {when(data.file.createdAt)} · SHA-256 <span title={data.file.sha256}>{data.file.sha256.slice(0, 12)}…</span></p> : null}
  </>;
  const copy = <section className={css.previewBare} aria-label="Filed copy"><PdfPages bytes={pdf?.bytes ?? null} label={`${label.title} ${d.number}`} /></section>;
  const synced = data.financeSyncedAt && d.issuedAt && data.financeSyncedAt > d.issuedAt;
  const others = data.related.filter((r) => !(r.sourceId === d.id && ["proforma", "invoice"].includes(r.docType)) && r.id !== d.sourceId && r.id !== d.againstId);

  return <div className={css.composer}>
    <div className={css.write}>
      <div className={css.top}>
        <ChainBar steps={chainSteps(d, data.related)} current={d.docType} />
        <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
      </div>

      <section className={styles.panel} aria-label="Summary" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className={css.head}>
          <div className={css.headTitle}><strong>{d.number}</strong><span>{TYPE_LABEL[d.docType]} · {d.buyer?.name || "No client"}{d.salespersonName ? ` · ${d.salespersonName}` : ""}</span></div>
          <span className={css.headTotal}>{inr(d.total)}</span>
        </div>
        {d.status === "cancelled" ? <p className={css.cancelled}>Cancelled {formatDate(d.cancelledAt)}: {d.cancelReason}</p> : null}
        <dl className={css.facts}>
          <div><dt>{label.date}</dt><dd>{formatDate(d.issueDate)}</dd></div>
          {d.dueDate ? <div><dt>Due</dt><dd>{formatDate(d.dueDate)}</dd></div> : null}
          {d.validUntil ? <div><dt>Valid until</dt><dd>{formatDate(d.validUntil)}</dd></div> : null}
          {d.docType === "invoice" ? <><div><dt>Received</dt><dd>{inr(d.paid)}</dd></div>{d.credited ? <div><dt>Credited</dt><dd>{inr(d.credited)}</dd></div> : null}
            <div><dt>Balance</dt><dd>{inr(Math.max(0, balance))}</dd></div></> : null}
          <div><dt>GST</dt><dd>{d.taxMode === "intra" ? "CGST + SGST" : "IGST"} · {d.placeOfSupply}</dd></div>
          <div><dt>Approved by</dt><dd>{d.issuedBy ?? "—"}</dd></div>
        </dl>
        {d.decision ? <p className={css.note}>Customer&apos;s answer: <b>{d.decision.decision}</b>{d.decision.name ? ` by ${d.decision.name}` : ""} · {when(d.decision.at)}{d.decision.via === "link" ? " (acceptance link)" : ""}</p> : null}
        {d.docType === "invoice" ? <p className={css.note}>{synced ? <>In Finance: the sales register and collections.</> : <>Joins Finance (sales register, collections, Reconcile) at the next sync.</>}</p> : null}
        <NextStep status={next?.status ?? idle} tone={d.status === "cancelled" ? "warning" : "info"} primary={main}
          secondary={<>{phone ? <button type="button" className={styles.btn} onClick={() => setPreview(true)}><Eye size={15} aria-hidden="true" />Preview</button> : null}{more}</>} />
      </section>

      {manual && !["cancelled", "converted"].includes(d.status) ? <section className={styles.panel} aria-label="Share it yourself" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <p className={css.note}><b>The PDF is downloaded.</b> This browser can&apos;t hand a file to WhatsApp, so attach it to a WhatsApp message to the customer yourself. Then use <b>Mark sent</b>: nothing is marked sent until you do.</p>
        <div><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void openWhatsApp()}><Send size={13} aria-hidden="true" />Open WhatsApp</button></div>
      </section> : null}

      {link ? <section className={styles.panel} aria-label="Acceptance link" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <p className={css.note}><b>Acceptance link</b> · share it with the customer yourself (Pulse doesn&apos;t send it). It is shown once and works for 30 days.</p>
        <div className={css.linkBox}><input readOnly value={link} aria-label="Acceptance link" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { void navigator.clipboard?.writeText(link); notify({ id: "erp-link", tone: "success", title: "Copied", timeout: 1500 }); }}><Copy size={13} aria-hidden="true" />Copy</button></div>
      </section> : null}

      {/* EST-1239 follow-up slot: the follow-up card's own "Log reply" button is hidden; the next step clicks it. */}
      {d.docType === "quotation" && !["draft", "issued"].includes(d.status) ? <div data-followup-slot="" className={css.follow}>
        <QuoteFollowUp quoteId={d.id} zone={zone} title={`${d.number ?? ""} · ${d.buyer?.name ?? ""}`} /></div> : null}

      {data.payments.length ? <div className={css.block}>
        <p className={css.label}>Payments</p>
        <LineList label="Payments">{data.payments.map((p) => <LineRow key={p.id} tone={p.voidedAt ? "muted" : undefined}
          title={`${inr(p.amount)}${p.tds ? ` + TDS ${inr(p.tds)}` : ""} · ${formatDate(p.receivedOn)}`}
          sub={[p.method, p.reference, p.bankLineKey ? "matched to a bank credit" : null, p.by, p.voidedAt ? `removed: ${p.voidReason}` : null].filter(Boolean).join(" · ")}
          end={w && !p.voidedAt ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => { const reason = window.prompt("Why is this payment removed?"); if (reason) void act(`erp/payments/${p.id}/void`, { reason }, "Payment removed"); }}>Remove</button> : undefined} />)}</LineList>
      </div> : null}

      {others.length ? <div className={css.block}>
        <p className={css.label}>Linked documents</p>
        <LineList label="Linked documents">{others.map((r) => <LineRow key={r.id} href={`/erp/documents/${r.id}`} title={`${TYPE_LABEL[r.docType]} ${r.number ?? "draft"}`} sub={formatDate(r.issueDate)}
          amount={inr(r.total)} amountSub={<Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>} />)}</LineList>
      </div> : null}

      <Disclosure summary="Activity" hint={`${data.events.length} entr${data.events.length === 1 ? "y" : "ies"}: every change, download and answer`}>{activity}</Disclosure>
    </div>

    <div className={css.view}>{phone ? null : <section className={css.copy} aria-label="Filed copy">
      <div className={css.copyHead}><span>Filed copy</span><span className={css.note}>The PDF as the customer gets it</span></div>
      <PdfPages bytes={pdf?.bytes ?? null} label={`${label.title} ${d.number}`} /></section>}</div>

    {preview ? <Drawer title={`${label.title} ${d.number}`} context={inr(d.total)} onClose={() => setPreview(false)} snap="full" bare noAutofocus
      panes={[{ key: "copy", label: "Filed copy", content: copy }, { key: "activity", label: "Activity", count: data.events.length || undefined, content: <DrawerSection title="Activity">{activity}</DrawerSection> }]}
      footer={main ? <DrawerFooter tone="info" primary={main} /> : undefined} /> : null}

    {reply ? <ReplyDrawer d={d} onClose={() => setReply(false)} act={act} /> : null}

    {pay ? <Drawer title="Record a payment" context={`${d.number} · balance ${inr(balance)}`} onClose={() => setPay(null)} snap="full"
      footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || pay.amount <= 0}
        onClick={async () => { if (await act(`erp/documents/${d.id}/payments`, pay, "Payment recorded")) setPay(null); }}>Record {inr(pay.amount + pay.tds)}</button>} />}>
      {data.bank.length ? <DrawerSection title="Bank credits that fit">
        <LineList label="Bank credits">{data.bank.map((b) => <LineRow key={b.key + b.variant} title={`${inr(b.amount)} · ${formatDate(b.date)}`} sub={[b.payer ?? "Payer not named", b.variant, b.reference].filter(Boolean).join(" · ")}
          selected={pay.bankLineKey === b.key}
          end={<button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPay({ ...pay, receivedOn: b.date, amount: b.amount, tds: Math.min(b.tds, balance - b.amount > 0 ? balance - b.amount : b.tds), reference: b.reference ?? "", bankLineKey: b.key })}>Use</button>} />)}</LineList>
      </DrawerSection> : null}
      <DrawerSection title="Payment">
        <div className={css.fields}>
          <label className={styles.field}>Received on<DateField value={pay.receivedOn} max={data.today} onChange={(e) => setPay({ ...pay, receivedOn: e.target.value })} /></label>
          <label className={styles.field}>Amount received ₹<input inputMode="decimal" defaultValue={formatAmount(pay.amount).replace(/,/g, "")} key={`a${pay.amount}`} onChange={(e) => { const p = toPaise(e.target.value); if (p !== null) setPay({ ...pay, amount: p }); }} /></label>
          <label className={styles.field}>TDS deducted ₹<input inputMode="decimal" defaultValue={formatAmount(pay.tds).replace(/,/g, "")} key={`t${pay.tds}`} onChange={(e) => { const p = toPaise(e.target.value); if (p !== null) setPay({ ...pay, tds: p }); }} /></label>
          <label className={styles.field}>How<SelectField value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="bank">Bank transfer</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="other">Other</option></SelectField></label>
          <label className={styles.field}>Reference<input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="UTR, cheque no." /></label>
        </div>
        {pay.bankLineKey ? <p className={css.note}>Matched to a bank credit: it won&apos;t be offered for another invoice.</p> : null}
      </DrawerSection>
    </Drawer> : null}
  </div>;
}


/** "Log reply" before the quotation has a follow-up: the customer accepted or declined. */
function ReplyDrawer({ d, onClose, act }: { d: Doc; onClose: () => void; act: (path: string, body: unknown, done: string) => Promise<unknown> }) {
  const [answer, setAnswer] = useState<"accepted" | "declined">("accepted"), [note, setNote] = useState("");
  return <Drawer title="Log reply" context={`${d.number} · ${d.buyer?.name ?? ""}`} size="sm" onClose={onClose} snap="half"
    footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={async () => { if (await act(`erp/documents/${d.id}/mark`, { action: answer, note: note || (answer === "accepted" ? "Recorded in Pulse" : "Declined") }, answer === "accepted" ? "Marked accepted" : "Marked declined")) onClose(); }}>Save reply</button>} />}>
    <DrawerSection title="What did the customer say?">
      <div className={css.radios} role="radiogroup" aria-label="What did the customer say?">
        <label className={css.radio}><input type="radio" name="erp-reply" checked={answer === "accepted"} onChange={() => setAnswer("accepted")} />They accepted it</label>
        <label className={css.radio}><input type="radio" name="erp-reply" checked={answer === "declined"} onChange={() => setAnswer("declined")} />They declined it</label>
      </div>
    </DrawerSection>
    <DrawerSection title="Note"><label className={styles.field}>Note (optional)<textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label></DrawerSection>
  </Drawer>;
}
