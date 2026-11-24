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
// BILLING (owner, 4 Nov 2026; Kazuk, 3 Nov): after negotiation the same quotation is revised (the approved copy is kept as
// a version, the number stays); making the tax invoice first asks "invoice it as it is, or revise it first?"; a cancelled
// quotation keeps its number and is re-issued under the next one; once the invoice is paid the project starts by itself
// and this page links to it.
// BILLING-WL (owner, 4 Nov 2026; Akabod: "Send on WhatsApp" searched forever). The button opens a sheet at once that says
// plainly whether Pulse can send it: until the company's WhatsApp Business number is linked it cannot, so the sheet offers
// the PDF (the phone's share sheet, or a download) and the customer's chat, and nothing waits without an end (the PDF and
// the acceptance link give up after a few seconds with a sentence saying what to do). A revised quotation shows R2, R3….
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Ban, CheckCheck, Copy, Download, Eye, FileMinus2, FileOutput, FolderOpen, FolderPlus, Link2, Mail, MapPin, MessageSquareReply, MoreHorizontal, PencilLine, RotateCcw, Send, Wallet, X, Printer } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { DOC_LABELS, formatAmount, formatDate, toPaise } from "@pulse/invoice-doc/browser";
import { post } from "../../../records";
import { useConfirm } from "../../../kit/dialogs";
import { Badge, styles } from "../../../ui";
import { Card, SectionHeader, StatTile, StatTiles } from "../../../components/calm";
import { Drawer, DrawerFooter, DrawerSection, useIsPhone } from "../../../kit/drawer";
import { Disclosure } from "../../../kit/disclosure";
import { LineList, LineRow } from "../../../kit/line-row";
import { ChainBar, NextStep } from "../../../kit/next-step";
import { Menu, type MenuItem } from "../../../kit/menu";
import { PdfPages } from "../../preview";
import { QuoteFollowUp } from "../../followup";
import { STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from "../../nav";
import { DEAL_LABEL, LOST_REASONS, VERSION_REASONS, type Doc, type DocumentData } from "../../types";
import { chainSteps, docNumber, EVENT, inr, when } from "../chain";
import css from "../documents.module.css";
import { DateField } from "../../../kit/date-field";
import { PortalShare } from "../portal-share";
import { PortalClaims } from "../portal-claims";
import { SelectField } from "../../../kit/select-field";
import { useWords } from "../../../org-code";
import { say } from "../../../lib/words.mjs";
import { EmailComposer } from "./email";
import { usePrompt } from "../../../kit/dialogs";

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
const METHOD: Record<string, string> = { bank: "Bank transfer", upi: "UPI", cheque: "Cheque", cash: "Cash", other: "Other" };
type Pay = { receivedOn: string; amount: number; tds: number; method: string; reference: string; bankLineKey: string | null; account: string;
  /** KAZUK-FLOW G10: the proof, read in the browser (PNG, JPEG or PDF, up to 5 MB). */ proof?: { mime: string; name: string; data: string } | null };
/** A file as base64 for the API (the proof of a payment). */
const asBase64 = (file: File) => new Promise<string>((done, no) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(",")[1] ?? ""); r.onerror = () => no(r.error); r.readAsDataURL(file); });
type Next = { label: string; icon: ReactNode; run: () => void; status: string } | null;
/** WhatsApp wants the number with its country code and no "+": a 10-digit Indian mobile gets 91. */
const waNumber = (phone?: string | null) => { const n = (phone ?? "").replace(/\D/g, ""); return n.length === 10 ? `91${n}` : n.length >= 11 ? n : ""; };
/** A fetch that gives up (BILLING-WL: nothing on this page waits without an end). */
const fetchWithin = (url: string, ms: number) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return fetch(url, { signal: ac.signal }).finally(() => clearTimeout(t)); };
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);

export function IssuedDocument({ data, zone, quietMain = false }: { data: DocumentData; zone: string; quietMain?: boolean }) {
  const ask = usePrompt();
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
  // KAZUK-FLOW G7/G8: a new version with its reason; a lost deal with its reason.
  const [versioning, setVersioning] = useState(false), [losing, setLosing] = useState(false);
  const [reply, setReply] = useState(false), [preview, setPreview] = useState(false), [shared, setShared] = useState(false), [manual, setManual] = useState(false);
  const [choose, setChoose] = useState(false), [sending, setSending] = useState(false), [failedKey, setFailedKey] = useState<string | null>(null);
  // BILLING-EMAIL: the e-mail composer (email.tsx); it sends only when its Send is pressed.
  const [emailing, setEmailing] = useState(false);
  // QUOTE-FIXES round 3 (re-test: "the GST and WhatsApp messages are cut off in a short toast"): the whole reason stays in
  // the next-step line under the document until the next thing done.
  const [problem, setProblem] = useState<string | null>(null);
  // OFFICE-PRINT (2503): More → Print: copies and sides, one confirm (a second above 20 pages), then the office printer.
  const [printing, setPrinting] = useState<{ copies: number; twoSided: boolean; ask: string | null } | null>(null);
  // QUOTE-FIXES: after WhatsApp opens, "Did you send it?" (what is already sent by e-mail rides along in the question).
  const [askSent, setAskSent] = useState<{ mailed: boolean } | null>(null);
  const confirm = useConfirm();
  const words = useWords();
  const balance = d.total - d.paid - d.credited;
  const number = docNumber(d) ?? d.number;
  const key = `${d.id}:${d.status}`, fileName = `${(number ?? "document").replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
  const pdfFailed = failedKey === key;
  useEffect(() => {
    let gone = false;
    fetchWithin(`/api/v0/erp/documents/${d.id}/pdf?inline=1`, 20000).then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => { if (gone) return; if (b) setPdf({ key, bytes: new Uint8Array(b), file: new File([b], fileName, { type: "application/pdf" }) }); else setFailedKey(key); })
      .catch(() => { if (!gone) setFailedKey(key); });
    return () => { gone = true; };
  }, [d.id, key, fileName]);
  async function act(path: string, body: unknown, done: string, go?: (r: Record<string, unknown>) => string | null) {
    if (busy) return null;
    setBusy(true);
    try { const r = await post<Record<string, unknown>>(path, body); setProblem(null); notify({ id: "erp-act", tone: "success", title: done, timeout: 3500 }); const to = go?.(r); if (to) router.push(to); else router.refresh(); return r; }
    catch (e) { setProblem(message(e)); notify({ id: "erp-act", tone: "error", title: "Not done", message: message(e) }); return null; } finally { setBusy(false); }
  }
  const w = data.canWrite;
  // KAZUK-FLOW (G2): with the company's approval off, a numbered document was sent, not approved; G1: a salesperson's
  // seat makes no credit note (the database refuses one).
  const free = data.approvalMode === "none", own = !!data.ownOnly;
  // KAZUK-FLOW G10: the salesperson's words ("Payment received"; the client tells them it is paid).
  const payLabel = free ? "Payment received" : "Record payment";
  const canEmail = !!w && ["quotation", "proforma", "invoice"].includes(d.docType) && ["issued", "sent", "accepted", "part_paid", "paid"].includes(d.status);
  // WL-QUOTE-LIVE: "📤 Send" on the quotation's Telegram card opens it with ?do=send: the e-mail composer (the PDF attached,
  // they check it and press Send) where the client has an e-mail; otherwise the page's Send buttons are right there.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("do") !== "send") return;
    u.searchParams.delete("do"); window.history.replaceState(null, "", u.pathname + u.search + u.hash);
    if (!canEmail || !d.buyer?.email) return;
    setTimeout(() => setEmailing(true), 0); // once: the link's ?do=send is gone after this
  }, [canEmail, d.buyer?.email]);
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
  const text = `${label.title} ${number} from ${d.seller?.tradeName || d.seller?.legalName || "us"}: ${inr(d.total)}`;
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
        const r = await fetchWithin(`/api/v0/erp/documents/${d.id}/pdf`, 20000).catch(() => null);
        if (!r?.ok) throw new Error("The PDF could not be prepared just now. Download it from the menu, or try again in a minute.");
        return new File([await r.blob()], fileName, { type: "application/pdf" });
      })();
      if (shareable(file)) {
        await navigator.share({ files: [file], title: `${label.title} ${number}`, text });
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
    const url = d.docType !== "credit_note" ? await within(acceptanceLink(), 8000).catch(() => null) : null;
    window.open(`https://wa.me/${waNumber(d.buyer?.phone)}?text=${encodeURIComponent(url ? `${text}\nSee it and accept: ${url}` : text)}`, "_blank", "noopener");
    if (url) setLink(url);
  }
  /** KAZUK-FLOW G5: one tap sends it both ways: the e-mail with the PDF (the composer's own message and recipient), and
   *  the customer's WhatsApp opened with the PDF's link; each channel is logged with the time and the version. */
  async function sendBoth() {
    if (busy) return;
    // QUOTE-LINKS: sent in the last 7 days: say when, and send again only on a yes (the server refuses a repeat e-mail too).
    const again = sentThisWeek;
    if (again && !(await confirm({ title: "Already sent", body: `${sentWords} Send it again?`, confirmLabel: "Send again" }))) return;
    // QUOTE-LINKS: on a phone the PDF itself goes through the share sheet (WhatsApp is one tap there), before anything is awaited.
    const file = pdf?.key === key && shareable(pdf.file) ? pdf.file : null;
    if (file) {
      try { await navigator.share({ files: [file], title: `${label.title} ${number}`, text }); }
      catch (e) { if (e instanceof DOMException && e.name === "AbortError") return; }
    }
    setBusy(true);
    const done: string[] = [];
    try {
      if (d.buyer?.email) {
        const g = await fetch(`/api/v0/erp/documents/${d.id}/email`, { cache: "no-store" }).then((r) => r.json()) as { to?: { email: string }[]; subject?: string; body?: string; acceptLink?: boolean; error?: string };
        if (g.error) throw new Error(g.error);
        const r = await post<{ sent: string[] }>(`erp/documents/${d.id}/email`, { to: (g.to ?? []).slice(0, 1).map((x) => x.email), subject: g.subject, body: g.body, acceptLink: g.acceptLink, resend: again });
        if (r.sent.length) done.push("e-mail");
      }
      if (file) { setAskSent({ mailed: done.length > 0 }); return; } // the PDF went through the share sheet: ask whether it was sent
      const url = d.docType !== "credit_note" ? await within(acceptanceLink(), 8000).catch(() => null) : null;
      const wa = `https://wa.me/${waNumber(d.buyer?.phone)}?text=${encodeURIComponent(url ? `${text}\nSee it and accept: ${url}` : text)}`;
      // QUOTE-FIXES (Mac test 21 Nov: "Sent by WhatsApp" although the browser blocked WhatsApp): opening WhatsApp is not
      // sending. With "noopener" the browser gives no window back, so a blocked one is found with a plain open first.
      const win = window.open("", "_blank");
      if (!win) {
        const why = `WhatsApp did not open: your browser blocked it, so it is not marked sent${done.length ? " by WhatsApp" : ""}. Allow pop-ups for Vitals, or use More → Send on WhatsApp.`;
        setProblem(why);
        notify({ id: "erp-send", tone: "error", title: done.length ? "E-mailed; WhatsApp did not open" : "WhatsApp did not open", message: why });
        router.refresh();
        return;
      }
      win.opener = null; win.location.href = wa;
      setAskSent({ mailed: done.length > 0 });
    } catch (e) { notify({ id: "erp-send", tone: "error", title: done.length ? `Sent by ${done.join(" and ")} only` : "Not sent", message: message(e) }); }
    finally { setBusy(false); }
  }
  /** QUOTE-FIXES: the answer to "Did you send it on WhatsApp?": Yes marks it sent (the follow-up starts); Not yet keeps it
   *  "Not sent yet" and notes that WhatsApp was opened. */
  async function answerSent(sent: boolean) {
    const mailed = askSent?.mailed ?? false;
    setAskSent(null);
    if (await act(`erp/documents/${d.id}/channel`, { channel: "whatsapp", sent }, sent ? `Sent by ${mailed ? "e-mail and WhatsApp" : "WhatsApp"}${d.docType === "quotation" ? ": the follow-up starts" : ""}`
      : mailed ? "E-mailed. WhatsApp: not sent yet" : "Not sent yet: it waits on Home until you send it")) router.refresh();
  }
  async function printIt(confirmLarge: boolean) {
    if (!printing || busy) return;
    setBusy(true);
    try {
      const r = await post<{ queued: boolean; ask?: string | null; job?: { title: string; copies: number } }>("office-print/jobs",
        { documentId: d.id, copies: printing.copies, sides: printing.twoSided ? "two-sided-long-edge" : "one-sided", confirmLarge });
      if (!r.queued) { setPrinting({ ...printing, ask: r.ask ?? "It is a long document. Print it anyway?" }); return; }
      setPrinting(null); setProblem(null);
      notify({ id: "erp-print", tone: "success", title: "Sent to the office printer", message: `${r.job?.copies ?? printing.copies} ${(r.job?.copies ?? printing.copies) === 1 ? "copy" : "copies"}: it prints in a few seconds. Billing → Printer shows it.`, timeout: 5000 });
    } catch (e) { setPrinting(null); setProblem(message(e)); notify({ id: "erp-print", tone: "error", title: "Not printed", message: message(e) }); }
    finally { setBusy(false); }
  }
  const markSent = () => act(`erp/documents/${d.id}/mark`, { action: "sent" }, d.docType === "quotation" ? "Marked sent: the follow-up starts" : "Marked sent");
  /** Log reply: the follow-up's own answer panel when its card is in the slot (EST-1239), else accepted / declined. */
  const logReply = () => {
    const button = [...(document.querySelector("[data-followup-slot]")?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Log reply"));
    if (button) button.click(); else setReply(true);
  };
  const download = (format: "pdf" | "docx") => { const a = document.createElement("a"); a.href = `/api/v0/erp/documents/${d.id}/${format}`; a.download = ""; document.body.append(a); a.click(); a.remove(); };
  const startPay = () => setPay({ receivedOn: data.today, amount: Math.max(0, balance), tds: 0, method: "bank", reference: "", bankLineKey: null, account: "" });
  // FINANCE-TRUTH (Kazuk, 4 Nov 2026: GST is paid into a separate account): the base and the GST can arrive apart.
  const gstAccount = data.paymentAccounts?.gstAccount ?? null, due = data.due ?? null;
  // A payment recorded before accounts were kept says none: Billing corrects which account it went into here.
  const payMenu = (p: DocumentData["payments"][number]): MenuItem[] => [
    ...(p.proofMime ? [{ key: "proof", label: "Open the proof", icon: <Eye size={15} aria-hidden="true" />, onSelect: () => { window.open(`/api/v0/erp/payments/${p.id}/proof`, "_blank", "noopener"); } }] : []),
    ...(data.paymentAccounts?.accounts.length ? [
      { key: "acct:", heading: "Paid into", label: "Not said (main account)", checked: !p.account, onSelect: () => { if (p.account) void act(`erp/payments/${p.id}/account`, { account: null }, "Account cleared"); } },
      ...data.paymentAccounts.accounts.map((a) => ({ key: `acct:${a}`, label: a === gstAccount ? `${a} (GST account)` : a, checked: p.account === a,
        onSelect: () => { if (p.account !== a) void act(`erp/payments/${p.id}/account`, { account: a }, `Paid into ${a}`); } }))] : []),
    { key: "remove", separator: !!data.paymentAccounts?.accounts.length, label: "Remove payment", danger: true, onSelect: async () => { const reason = await ask({ title: "Remove this payment?", label: "Why are you removing it?", helper: "We keep this note in the log.", confirmLabel: "Remove payment", multiline: true, maxLength: 300, danger: true }); if (reason) void act(`erp/payments/${p.id}/void`, { reason }, "Payment removed"); } },
  ];
  const cancel = async () => { const note = await ask({ title: `Cancel ${d.number}?`, label: "Why is it cancelled?", helper: "We keep this note in the log.", confirmLabel: `Cancel ${label.noun}`, cancelLabel: "Keep it", multiline: true, maxLength: 300, danger: true }); if (note) void act(`erp/documents/${d.id}/mark`, { action: "cancel", note }, `${label.title} cancelled`); };
  /** Revise the same quotation: the approved copy is filed as a version and the quotation opens as a draft, same number. */
  const revise = () => setVersioning(true);
  const reissue = () => data.reissue ? router.push(`/erp/documents/${data.reissue.id}`)
    : void act(`erp/documents/${d.id}/reissue`, {}, `New ${label.noun} draft: it takes the next number when ${free ? "sent" : "approved"}`, (r) => `/erp/documents/${r.id}`);
  const startProject = () => void act(`erp/documents/${d.id}/project`, {}, "Project started", (r) => (typeof r.projectId === "string" ? `/tasks/projects/${r.projectId}` : null));
  const revisable = d.docType === "quotation" && ["issued", "sent", "accepted", "declined"].includes(d.status) && !data.related.some((r) => r.sourceId === d.id && r.status !== "cancelled");
  /** Make the tax invoice from a quotation: first the choice (Kazuk: "this one, as it is, or changes first?"). */
  const toInvoice = () => (d.docType === "quotation" && !madeFrom("invoice") && revisable ? setChoose(true) : make("invoice"));

  const openInvoice = d.docType === "invoice" && ["issued", "sent", "part_paid"].includes(d.status);
  const convertible = ["quotation", "proforma"].includes(d.docType) && ["issued", "sent", "accepted"].includes(d.status);
  const later = madeFrom;
  // QUOTE-FIXES round 4 (DEVICE-BUG-1539): a document with no GST (no GSTIN, or 0% lines) never says "incl. GST" or IGST ₹0.
  const taxFree = Number(d.cgst ?? 0) + Number(d.sgst ?? 0) + Number(d.igst ?? 0) === 0;
  // QUOTE-FIXES: a numbered proforma not yet sent leads with Send; its tax invoice is a button beside it, not only in More.
  const proformaInvoice = !!w && d.docType === "proforma" && d.status === "issued";
  // SX-QUOTES (2525; Sales X-Ray's "one delivery owner", the fix for re-sending): when Sales X-Ray sends this quotation,
  // Pulse offers no Send of its own and says what Sales X-Ray sent.
  const appSends = data.delivery?.owner === "sales_xray";
  const lastApp = data.delivery?.items[0] ?? null;
  const appWords = appSends ? (lastApp ? `Sent from ${lastApp.app ?? "Sales X-Ray"} on ${formatDate(lastApp.sentAt.slice(0, 10))} (${lastApp.channel.replace("_", " ")})${lastApp.by ? ` by ${lastApp.by}` : ""}.` : "Sales X-Ray sends this quotation to the customer.") : "";
  // QUOTE-LINKS (owner, 22 Nov 2026: "we keep sending spammy links again and again"): when it last went out, and how.
  const sends = data.events.filter((e) => (e.kind === "emailed" || e.kind === "whatsapp_sent") && Number(e.detail?.revision ?? 0) === Number(d.revision ?? 0));
  const lastSend = sends.reduce<typeof sends[number] | null>((a, e) => (!a || e.at > a.at ? e : a), null);
  const sentWords = lastSend ? `Last sent ${formatDate(lastSend.at.slice(0, 10))} by ${lastSend.kind === "emailed" ? `e-mail${Array.isArray(lastSend.detail?.to) ? ` to ${(lastSend.detail.to as string[]).join(", ")}` : ""}` : "WhatsApp"}.` : "";
  const sentThisWeek = !!lastSend && lastSend.at.slice(0, 10) >= new Date(Date.parse(`${data.today}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
  const next: Next = !w || (d.status === "cancelled" && d.docType !== "quotation") ? null
    : appSends && ["issued", "sent"].includes(d.status) ? d.status === "sent" ? { label: "Log reply", icon: <MessageSquareReply size={15} aria-hidden="true" />, run: logReply, status: `With the customer: log their answer when they reply. ${appWords}` } : null
    : shared && d.status === "issued" ? { label: "Mark sent", icon: <CheckCheck size={15} aria-hidden="true" />, run: () => void markSent(), status: `Shared. Once it is with the customer, mark it sent${d.docType === "quotation" ? ": the follow-up starts then" : ""}.` }
    : free && d.status === "issued" && d.docType !== "credit_note" ? { label: d.buyer?.email ? "Send (e-mail + WhatsApp)" : "Send on WhatsApp", icon: <Send size={15} aria-hidden="true" />, run: () => void sendBoth(),
      status: `${d.buyer?.email ? `E-mails ${d.buyer.email} the PDF` : "No e-mail on it"} and opens WhatsApp${d.buyer?.phone ? ` to ${d.buyer.phone}` : ""} with its link. Both are logged.` }
    : d.status === "issued" ? { label: "Send on WhatsApp", icon: <Send size={15} aria-hidden="true" />, run: () => setSending(true), status: `${free ? "Numbered" : "Approved"} ${formatDate(d.issuedAt?.slice(0, 10) ?? d.issueDate)}. Send it to the customer next.` }
    : d.docType === "quotation" && d.status === "sent" ? { label: "Log reply", icon: <MessageSquareReply size={15} aria-hidden="true" />, run: logReply, status: `With the customer: log their answer when they reply.${sentWords ? ` ${sentWords}` : ""}` }
    : d.docType === "quotation" && d.status === "accepted" ? later("proforma") ? { label: "Open the proforma", icon: <FileOutput size={15} aria-hidden="true" />, run: () => make("proforma"), status: "The customer agreed; the proforma is made." }
      : { label: later("invoice") ? "Open the tax invoice" : "Make tax invoice", icon: <FileOutput size={15} aria-hidden="true" />, run: toInvoice, status: "The customer agreed. Invoice it as it is, or revise it first: client, lines and terms carry over." }
    : d.docType === "quotation" && d.status === "declined" ? { label: "Revise quotation", icon: <PencilLine size={15} aria-hidden="true" />, run: revise, status: `The customer declined. Revise it (same number, the ${free ? "sent" : "approved"} copy is kept) to send it again.` }
    : d.docType === "quotation" && d.status === "cancelled" ? { label: data.reissue ? "Open the re-issue" : "Re-issue as a new quotation", icon: <RotateCcw size={15} aria-hidden="true" />, run: reissue,
      status: `Cancelled ${formatDate(d.cancelledAt)}: ${d.cancelReason ?? ""}. It keeps its number; a re-issue takes the next.` }
    : d.docType === "proforma" && ["sent", "accepted"].includes(d.status) ? { label: later("invoice") ? "Open the tax invoice" : "Make tax invoice", icon: <FileOutput size={15} aria-hidden="true" />, run: () => make("invoice"), status: "When the advance is in, the tax invoice carries everything over." }
    : d.status === "converted" ? (() => { const t = later("invoice") ?? later("proforma") ?? data.related.find((r) => r.sourceId === d.id); return t ? { label: `Open the ${TYPE_LABEL[t.docType].toLowerCase()}`, icon: <FileOutput size={15} aria-hidden="true" />, run: () => open(t), status: `Converted into ${TYPE_LABEL[t.docType].toLowerCase()} ${t.number ?? "draft"}.` } : null; })()
    : openInvoice ? { label: payLabel, icon: <Wallet size={15} aria-hidden="true" />, run: startPay, status: `${inr(Math.max(0, balance))} to collect${d.dueDate ? ` · due ${formatDate(d.dueDate)}` : ""}${d.dueDate && d.dueDate < data.today ? " (overdue)" : ""}.${d.status !== "part_paid" && !d.projectId && !data.startedProject ? (d.sourceId && !data.projectOffer ? " When the money is in, the project starts by itself." : " No project starts by itself from this invoice; once it is paid you can start one.") : ""}` }
    : d.docType === "invoice" && d.status === "paid" && data.startedProject ? { label: "Open the project", icon: <FolderOpen size={15} aria-hidden="true" />, run: () => router.push(`/tasks/projects/${data.startedProject!.id}`),
      status: `Paid in full. ${data.startedProject.title} ${data.startedProject.assigned ? `is with ${data.startedProject.owner}` : "waits for a project head to choose its owner and category"}.` }
    : d.docType === "invoice" && d.status === "paid" && !d.projectId ? { label: "Start the project", icon: <FolderPlus size={15} aria-hidden="true" />, run: startProject,
      status: data.projectOffer?.reason === "live" ? `Paid in full. ${data.projectOffer.project ? `The client's project, ${data.projectOffer.project},` : "The client's project"} is already running, so no new project started; start one only if this is new work.`
        : data.projectOffer?.reason === "blank" || !d.sourceId ? "Paid in full. This invoice is not from a quotation, so no project started by itself; start one if this is new work."
        : "Paid in full. The project did not start by itself (see Activity): start it now." }
    : null;
  const idle = appSends && ["issued", "sent"].includes(d.status) ? appWords : d.status === "cancelled" ? `Cancelled ${formatDate(d.cancelledAt)}: ${d.cancelReason ?? ""}${data.reissue ? ` · re-issued as ${data.reissue.number ?? "a draft"}` : ""}` : d.status === "paid" ? "Paid in full." : d.status === "declined" ? "The customer declined it." : !w ? "Read only." : "Nothing more to do.";

  const menu: MenuItem[] = [
    ...(!["draft", "cancelled"].includes(d.status) ? [{ key: "print", label: "Print", hint: "On the office printer", icon: <Printer size={15} aria-hidden="true" />, onSelect: () => setPrinting({ copies: 1, twoSided: false, ask: null }) }] : []),
    { key: "pdf", label: "Download PDF", icon: <Download size={15} aria-hidden="true" />, onSelect: () => download("pdf") },
    { key: "docx", label: "Download Word file", icon: <Download size={15} aria-hidden="true" />, onSelect: () => download("docx") },
    ...(!appSends && canEmail ? [{ key: "email", label: "Send by email", hint: d.buyer?.email ? "The PDF attached; you check the message first" : "No e-mail on the client: type one first", icon: <Mail size={15} aria-hidden="true" />, onSelect: () => setEmailing(true) }] : []),
    ...(!appSends && w && free && ["sent", "accepted"].includes(d.status) && d.docType !== "credit_note" ? [{ key: "both", label: d.buyer?.email ? "Send again (e-mail + WhatsApp)" : "Send again on WhatsApp", icon: <Send size={15} aria-hidden="true" />, onSelect: () => void sendBoth() }] : []),
    ...(!appSends && w && d.status !== "cancelled" && next?.label !== "Send on WhatsApp" && d.status !== "converted" ? [{ key: "share", label: "Send on WhatsApp", icon: <Send size={15} aria-hidden="true" />, onSelect: () => setSending(true) }] : []),
    ...(!appSends && w && d.status === "issued" && next?.label !== "Mark sent" ? [{ key: "sent", label: "Mark sent", hint: "It was handed to the customer", icon: <CheckCheck size={15} aria-hidden="true" />, onSelect: () => void markSent() }] : []),
    ...(w && revisable && next?.label !== "Revise quotation" ? [{ key: "revise", label: "Revise quotation", hint: `Same number; the ${free ? "sent" : "approved"} copy is kept`, icon: <PencilLine size={15} aria-hidden="true" />, onSelect: revise }] : []),
    // KAZUK-FLOW G7: the customer replied and the deal goes on; or it is lost, with its reason.
    ...(w && d.docType === "quotation" && ["issued", "sent"].includes(d.status) ? [
      { key: "neg", label: "Customer is negotiating", hint: "They replied; the deal goes on", icon: <MessageSquareReply size={15} aria-hidden="true" />,
        onSelect: () => void act(`erp/documents/${d.id}/mark`, { action: "negotiating" }, "Negotiating") },
      { key: "lost", label: "Mark lost", hint: "With the reason", icon: <X size={15} aria-hidden="true" />, onSelect: () => setLosing(true) }] : []),
    ...(w && ["quotation", "proforma"].includes(d.docType) && ["issued", "sent"].includes(d.status) ? [
      { key: "acc", label: "Customer accepted", icon: <CheckCheck size={15} aria-hidden="true" />, onSelect: () => void act(`erp/documents/${d.id}/mark`, { action: "accepted", note: "Recorded in Pulse" }, "Marked accepted") },
      { key: "dec", label: "Customer declined", icon: <X size={15} aria-hidden="true" />, onSelect: async () => { const note = await ask({ title: "Mark it as declined?", label: "What did the customer say?", helper: "Optional. We keep this note in the log.", confirmLabel: "Mark declined", multiline: true, maxLength: 300, required: false }); if (note !== null) void act(`erp/documents/${d.id}/mark`, { action: "declined", note: note || "Declined" }, "Marked declined"); } }] : []),
    // An accepted quotation is convertible too, so this one entry covers it (a second "Make proforma" for accepted
    // quotations listed the same step twice in the menu).
    ...(w && !data.proformaHidden && convertible && d.docType === "quotation" && !next?.label.includes("proforma") ? [{ key: "pro", label: later("proforma") ? "Open the proforma" : "Make proforma", icon: <FileOutput size={15} aria-hidden="true" />, onSelect: () => make("proforma") }] : []),
    ...(w && convertible && !proformaInvoice && !next?.label.includes("tax invoice") ? [{ key: "inv", label: later("invoice") ? "Open the tax invoice" : "Make tax invoice", icon: <FileOutput size={15} aria-hidden="true" />, onSelect: toInvoice }] : []),
    ...(w && openInvoice && next?.label !== payLabel ? [{ key: "pay", label: payLabel, icon: <Wallet size={15} aria-hidden="true" />, onSelect: startPay }] : []),
    ...(w && ["quotation", "proforma", "invoice"].includes(d.docType) && ["issued", "sent", "part_paid", "paid"].includes(d.status) ? [{ key: "link", label: "Make an acceptance link", hint: "Shown once; you share it", icon: <Link2 size={15} aria-hidden="true" />,
      onSelect: () => void acceptanceLink().then(setLink).catch((e) => notify({ id: "erp-link", tone: "error", title: "No link", message: message(e) })) }] : []),
    ...(w && !own && d.docType === "invoice" && ["issued", "sent", "part_paid", "paid"].includes(d.status) && d.credited < d.total ? [{ key: "cn", label: "Credit note", icon: <FileMinus2 size={15} aria-hidden="true" />,
      onSelect: () => void act("erp/documents", { docType: "credit_note", againstId: d.id }, "Credit note draft made", (r) => `/erp/documents/${r.id}`) }] : []),
    ...(w && !["cancelled", "converted", "paid", "part_paid"].includes(d.status) && !(d.docType === "invoice" && d.credited) ? [{ key: "cancel", label: `Cancel ${label.noun}`, icon: <Ban size={15} aria-hidden="true" />, danger: true, separator: true, onSelect: cancel }] : []),
  ];
  const more = <Menu label="More actions" items={menu} className={css.more} buttonLabel="More actions"><MoreHorizontal size={16} aria-hidden="true" /></Menu>;
  // LAND-CAPTAIN-11: the agreement flow's card above leads when it offers the next step (quietMain); this stays as an ordinary button.
  const main = next ? <button type="button" className={quietMain ? styles.btn : `${styles.btn} ${styles.btnPrimary}`} data-primary={quietMain ? undefined : ""} disabled={busy} onClick={next.run}>{next.icon}{next.label}</button> : null;
  const activity = <>
    <ol className={css.activity}>{data.events.map((e, i) => <li key={i}><b>{free && e.kind === "issued" ? "Numbered" : EVENT[e.kind] ?? e.kind}{(e.kind === "emailed" || e.kind === "email_failed") && Array.isArray(e.detail?.to) ? ` to ${(e.detail.to as string[]).join(", ")}` : ""}</b><span>{when(e.at)}{e.actor ? ` · ${e.actor}` : e.kind.startsWith("client") || e.kind === "link_opened" ? " · customer" : ""}</span></li>)}</ol>
    {data.links.length ? <p className={css.note}>Acceptance links: {data.links.map((l) => `${formatDate(l.createdAt)} (${l.decision ? `${l.decision} by ${l.signer}` : l.revokedAt ? "replaced" : l.openedAt ? "opened" : "not opened"})`).join(", ")}</p> : null}
    {data.file ? <p className={css.note}>Filed copy {when(data.file.createdAt)} · SHA-256 <span title={data.file.sha256}>{data.file.sha256.slice(0, 12)}…</span></p> : null}
  </>;
  const copy = <section className={css.previewBare} aria-label="Filed copy"><PdfPages bytes={pdf?.bytes ?? null} label={`${label.title} ${number}`} /></section>;
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
          <div className={css.headTitle}><strong>{number}</strong><span>{TYPE_LABEL[d.docType]} · {d.buyer?.name || "No client"}{d.salespersonName ? ` · ${d.salespersonName}` : ""}</span></div>
        </div>
        {d.status === "cancelled" ? <p className={css.cancelled}>Cancelled {formatDate(d.cancelledAt)}: {d.cancelReason}</p> : null}
        {/* UX-BILLING (5 Nov 2026): My day's stat tiles: what it is worth, what came in, what is left and by when; a bar shows
            how much of an invoice is paid. The rest (GST, who approved it) in a quiet line. */}
        {d.docType === "invoice" ? <>
          <StatTiles label="Money on this invoice">
            <StatTile label="Total" value={inr(d.total)} />
            <StatTile label="Received" value={inr(d.paid)} tone={d.paid ? "good" : undefined} sub={d.credited ? `${inr(d.credited)} credited` : undefined} />
            <StatTile label="Balance" value={inr(Math.max(0, balance))} tone={balance > 0 && d.dueDate && d.dueDate < data.today ? "bad" : balance <= 0 ? "good" : undefined} />
            <StatTile label={d.dueDate && d.dueDate < data.today && balance > 0 ? "Overdue since" : "Due"} value={d.dueDate ? formatDate(d.dueDate) : "—"} tone={d.dueDate && d.dueDate < data.today && balance > 0 ? "bad" : undefined} />
          </StatTiles>
          {d.total > 0 ? <span className={css.paidBar} role="meter" aria-label="Paid so far" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(((d.paid + d.credited) / d.total) * 100))}>
            <i style={{ width: `${Math.min(100, ((d.paid + d.credited) / d.total) * 100)}%` }} data-full={balance <= 0 ? "" : undefined} /></span> : null}
          {d.total > 0 ? <small className={css.paidNote}>{balance <= 0 ? "Paid in full" : d.paid + d.credited > 0 ? `${Math.round(((d.paid + d.credited) / d.total) * 100)}% paid · ${inr(Math.max(0, balance))} to collect` : `Nothing received yet · ${inr(Math.max(0, balance))} to collect`}</small> : null}
        </> : <StatTiles label="This document">
          <StatTile label="Total" value={inr(d.total)} sub={taxFree ? "no GST" : `incl. ${d.taxMode === "intra" ? "CGST + SGST" : "IGST"}`} />
          <StatTile label={label.date} value={formatDate(d.issueDate)} />
          {d.validUntil ? <StatTile label="Valid until" value={formatDate(d.validUntil)} tone={d.validUntil < data.today && ["issued", "sent"].includes(d.status) ? "bad" : undefined} /> : <StatTile label="Status" value={STATUS_LABEL[d.status]} />}
          <StatTile label={free ? "Numbered by" : "Approved by"} value={d.issuedBy ?? "—"} />
        </StatTiles>}
        {/* BILLING-EMAIL (Kazuk, 5 Nov 2026): where the project is, apart from the address the document is billed to. */}
        {d.siteLocation || d.buyer?.address?.length ? <p className={css.note} data-where="">
          {d.siteLocation ? <><MapPin size={12} aria-hidden="true" /> {say("{Project} location", words)}: <b>{d.siteLocation}</b></> : null}
          {d.siteLocation && d.buyer?.address?.length ? <br /> : null}
          {d.buyer?.address?.length ? <>Billing address: {d.buyer.address.filter(Boolean).join(", ")}</> : null}</p> : null}
        {/* KAZUK-FLOW G7/G8: the deal's one status, the version, and the version an invoice was made from. */}
        {d.dealStatus || d.sourceRevision !== null && d.sourceRevision !== undefined ? <p className={css.note} data-deal={d.dealStatus ?? ""}>
          {d.dealStatus ? <>Deal: <b>{DEAL_LABEL[d.dealStatus]}</b>{d.docType === "quotation" ? ` · V${(d.revision ?? 0) + 1}` : ""}{d.lostReason ? ` · lost on ${LOST_REASONS.find(([k]) => k === d.lostReason)?.[1].toLowerCase() ?? d.lostReason}${d.lostNote ? `: ${d.lostNote}` : ""}` : ""}</> : null}
          {d.sourceRevision !== null && d.sourceRevision !== undefined ? <>{d.dealStatus ? " · " : ""}From {data.related.find((r) => r.id === d.sourceId)?.number ?? "the quotation"} <b>V{d.sourceRevision + 1}</b></> : null}</p> : null}
        <p className={css.note}>{d.docType === "invoice" ? `${label.date} ${formatDate(d.issueDate)} · ${taxFree ? "no GST" : d.taxMode === "intra" ? "CGST + SGST" : "IGST"} · ` : ""}Place of supply {d.placeOfSupply}{d.docType === "invoice" && d.issuedBy ? ` · ${free ? "issued" : "approved"} by ${d.issuedBy}` : ""}</p>
        {d.decision ? <p className={css.note}>Customer&apos;s answer: <b>{d.decision.decision}</b>{d.decision.name ? ` by ${d.decision.name}` : ""} · {when(d.decision.at)}{d.decision.via === "link" ? " (acceptance link)" : ""}</p> : null}
        {d.docType === "invoice" ? <p className={css.note}>{synced ? <>In Finance: the sales register and collections.</> : <>Shows up in Finance (sales list and payments) after the next update.</>}</p> : null}
        {/* KAZUK-FLOW config (1671): what the company's sales flow keeps from this person here, and who can do it. */}
        {/* (The invoice lock is about blank invoices; an invoice made from a quotation is never stopped by it.) */}
        {Object.values(data.blocks ?? {}).some((b) => b.step !== "invoice")
          ? <ul className={css.note} aria-label="Steps not yours here">{Object.values(data.blocks ?? {}).filter((b) => b.step !== "invoice").map((b) => <li key={b.step} data-flow-block={b.step}>{b.why}{b.unlockBy.length ? `: ${b.unlockBy.join(", ")} can do it` : ""}</li>)}</ul> : null}
        {/* Preview is a phone's button, drawn from the first HTML and hidden on wider screens by CSS: when useIsPhone added it
            after hydration, the next step's buttons wrapped and "Send on WhatsApp" moved 52 px under an early tap. */}
        <NextStep float={!quietMain} status={problem ?? next?.status ?? idle} tone={problem ? "error" : d.status === "cancelled" ? "warning" : "info"} primary={main}
          secondary={<>{proformaInvoice ? <button type="button" className={styles.btn} disabled={busy} onClick={() => make("invoice")}><FileOutput size={15} aria-hidden="true" />{later("invoice") ? "Open the tax invoice" : "Make tax invoice"}</button> : null}{!appSends && canEmail && d.buyer?.email ? <button type="button" className={styles.btn} disabled={busy} onClick={() => setEmailing(true)}><Mail size={15} aria-hidden="true" />Send by email</button> : null}<button type="button" className={`${styles.btn} ${css.phoneOnly}`} onClick={() => setPreview(true)}><Eye size={15} aria-hidden="true" />Preview</button>{more}</>} />
      </section>

      {manual && !["cancelled", "converted"].includes(d.status) ? <section className={styles.panel} aria-label="Share it yourself" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <p className={css.note}><b>The PDF is downloaded.</b> This browser can&apos;t put the file into WhatsApp for you. Open WhatsApp, attach the PDF and send it to the customer. Then tap <b>Mark sent</b>. Until you do, it is not marked as sent.</p>
        <div><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void openWhatsApp()}><Send size={13} aria-hidden="true" />Open WhatsApp</button></div>
      </section> : null}

      {link ? <section className={styles.panel} aria-label="Acceptance link" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <p className={css.note}><b>Acceptance link</b> · share it with the customer yourself (Pulse doesn&apos;t send it). It is shown once and works for 30 days.</p>
        <div className={css.linkBox}><input readOnly value={link} aria-label="Acceptance link" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { void navigator.clipboard?.writeText(link); notify({ id: "erp-link", tone: "success", title: "Copied", timeout: 1500 }); }}><Copy size={13} aria-hidden="true" />Copy</button></div>
      </section> : null}

      {/* CLIENT-PORTAL: the document in the client's own Pulse space, where they answer it. */}
      <PortalShare id={d.id} issued={["issued", "sent", "part_paid", "paid", "accepted"].includes(d.status)} canWrite={!!w} />
      {/* PORTAL-2: payments the client told us about from their space ("I've paid"), to check and record. */}
      {d.docType === "invoice" ? <PortalClaims id={d.id} canWrite={!!w} onRecorded={() => router.refresh()} /> : null}

      {/* EST-1239 follow-up slot: the follow-up card's own "Log reply" button is hidden; the next step clicks it. */}
      {d.docType === "quotation" && !["draft", "issued"].includes(d.status) ? <div data-followup-slot="" className={css.follow}>
        <QuoteFollowUp quoteId={d.id} zone={zone} title={`${d.number ?? ""} · ${d.buyer?.name ?? ""}`} /></div> : null}

      {d.docType === "invoice" && data.startedProject ? <Card label="Project" flat>
        <SectionHeader icon={<FolderOpen size={16} aria-hidden="true" />} title="Project" />
        <LineList label="Project"><LineRow lead={<FolderOpen size={16} aria-hidden="true" />} href={`/tasks/projects/${data.startedProject.id}`} title={data.startedProject.title}
          sub={data.startedProject.assigned ? `Owner: ${data.startedProject.owner}` : "Started by the payment · the project heads choose its owner and client category"} /></LineList>
      </Card> : null}
      {d.reissueOf || data.reissue ? <p className={css.note}>{d.reissueOf ? <>Re-issues a cancelled {label.noun}: <Link href={`/erp/documents/${d.reissueOf}`}>open it</Link>. </> : null}
        {data.reissue ? <>Re-issued as <Link href={`/erp/documents/${data.reissue.id}`}>{data.reissue.number ?? "a draft"}</Link>.</> : null}</p> : null}

      {data.payments.length ? <Card label="Payments" flat>
        <SectionHeader icon={<Wallet size={16} aria-hidden="true" />} title="Payments" count={data.payments.length} />
        <LineList label="Payments">{data.payments.map((p) => <LineRow key={p.id} tone={p.voidedAt ? "muted" : undefined}
          title={`${inr(p.amount)}${p.tds ? ` + TDS ${inr(p.tds)}` : ""} · ${formatDate(p.receivedOn)}`}
          sub={[METHOD[p.method] ?? p.method, p.account ? `into ${p.account}${p.account === gstAccount ? " (GST account)" : ""}` : null, p.reference, p.proofMime ? "proof attached" : null, p.bankLineKey ? "matched to a bank credit" : null, p.by, p.voidedAt ? `removed: ${p.voidReason}` : null].filter(Boolean).join(" · ")}
          end={p.proofMime && !(w && !p.voidedAt) ? <a className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={`/api/v0/erp/payments/${p.id}/proof`} target="_blank" rel="noopener">Proof</a>
            : w && !p.voidedAt ? <Menu label={`Payment of ${inr(p.amount)}`} buttonLabel={`Payment of ${inr(p.amount)}: paid into, remove`} className={css.more} items={payMenu(p)}><MoreHorizontal size={16} aria-hidden="true" /></Menu> : undefined} />)}</LineList>
        {w && gstAccount && data.payments.some((p) => !p.voidedAt && !p.account) ? <p className={css.note}>A payment that does not say which account it went into counts as the main account, so it pays the amount without GST first. If it was the GST, choose “Paid into {gstAccount}” on it.</p> : null}
      </Card> : null}

      {others.length ? <Card label="Linked documents" flat>
        <SectionHeader icon={<Link2 size={16} aria-hidden="true" />} title="Linked documents" count={others.length} />
        <LineList label="Linked documents">{others.map((r) => <LineRow key={r.id} href={`/erp/documents/${r.id}`} title={`${TYPE_LABEL[r.docType]} ${r.number ?? "draft"}`} sub={formatDate(r.issueDate)}
          amount={inr(r.total)} amountSub={<Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>} />)}</LineList>
      </Card> : null}

      {data.versions?.length ? <Versions id={d.id} number={d.number} revision={d.revision ?? 0} versions={data.versions} free={free} /> : null}
      <Disclosure summary="Activity" hint={`${data.events.length} entr${data.events.length === 1 ? "y" : "ies"}: every change, download and answer`}>{activity}</Disclosure>
    </div>

    <div className={css.view}>{phone ? null : <section className={css.copy} aria-label="Filed copy">
      <div className={css.copyHead}><span>Filed copy</span><span className={css.note}>The PDF as the customer gets it</span></div>
      <PdfPages bytes={pdf?.bytes ?? null} label={`${label.title} ${number}`} /></section>}</div>

    {preview ? <Drawer title={`${label.title} ${number}`} context={inr(d.total)} onClose={() => setPreview(false)} snap="full" bare noAutofocus
      panes={[{ key: "copy", label: "Filed copy", content: copy }, { key: "activity", label: "Activity", count: data.events.length || undefined, content: <DrawerSection title="Activity">{activity}</DrawerSection> }]}
      footer={main ? <DrawerFooter tone="info" primary={main} /> : undefined} /> : null}

    {emailing ? <EmailComposer docId={d.id} title="Send by email" context={`${number} · ${d.buyer?.name ?? ""}`} onClose={() => setEmailing(false)}
      onSent={() => { setEmailing(false); router.refresh(); }} /> : null}

    {reply ? <ReplyDrawer d={d} onClose={() => setReply(false)} act={act} /> : null}
    {versioning ? <ReasonDrawer title={`New version: V${(d.revision ?? 0) + 2}`} context={`${d.number} keeps its number; V${(d.revision ?? 0) + 1} is kept as it was sent`} reasons={VERSION_REASONS}
      ask="Why a new version?" button="Start the new version" onClose={() => setVersioning(false)}
      onSave={(kind, note) => act(`erp/documents/${d.id}/revise`, { kind, note }, `V${(d.revision ?? 0) + 2} started: V${(d.revision ?? 0) + 1} is kept`)} /> : null}
    {losing ? <ReasonDrawer title="Mark lost" context={`${d.number} · ${d.buyer?.name ?? ""}`} reasons={LOST_REASONS} ask="Why was it lost?" button="Mark lost" onClose={() => setLosing(false)}
      onSave={(reason, note) => act(`erp/documents/${d.id}/mark`, { action: "lost", reason, note }, "Marked lost")} /> : null}

    {sending ? <Drawer title="Send on WhatsApp" context={`${number} · ${d.buyer?.name ?? ""}`} size="sm" onClose={() => setSending(false)} snap="full"
      footer={<DrawerFooter tone="info"
        primary={phone ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void send()}><Send size={15} aria-hidden="true" />{pdf || !pdfFailed ? "Share the PDF" : "Try the PDF again"}</button>
          : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => { download("pdf"); void openWhatsApp(); }}><Send size={15} aria-hidden="true" />Download PDF and open WhatsApp</button>}>
        {shared || manual ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => { setSending(false); void markSent(); }}><CheckCheck size={14} aria-hidden="true" />Mark sent</button> : null}
      </DrawerFooter>}>
      <DrawerSection title={data.whatsapp?.connected ? "WhatsApp Business" : "What is missing"}>
        <p className={css.note}>{data.whatsapp?.connected ? "The message goes from the company's WhatsApp Business number." : <><b>Pulse can&apos;t send WhatsApp messages for you yet.</b> {data.whatsapp?.next ?? ""}</>}</p>
      </DrawerSection>
      <DrawerSection title="Send it yourself, in three steps">
        <ol className={css.steps}>
          <li><b>{phone ? "Share the PDF" : "Download the PDF"}</b>{pdf ? " · ready" : pdfFailed ? " · could not be prepared (try again, or use Download PDF in the menu)" : " · preparing…"}</li>
          <li><b>Send it to {d.buyer?.name || "the customer"}</b>{waNumber(d.buyer?.phone) ? ` on ${d.buyer?.phone}` : ": there is no phone on it, so WhatsApp asks whom to send it to"}</li>
          <li><b>Mark it sent</b>{d.docType === "quotation" ? ": the follow-up starts then" : ""}</li>
        </ol>
        <div className={styles.inline}>
          {phone ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void openWhatsApp()}><Send size={13} aria-hidden="true" />Open the chat</button> : null}
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => download("pdf")}><Download size={13} aria-hidden="true" />Download PDF</button>
          {!shared && !manual ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => { setSending(false); void markSent(); }}><CheckCheck size={13} aria-hidden="true" />It is sent: mark sent</button> : null}
        </div>
      </DrawerSection>
    </Drawer> : null}

    {printing ? <Drawer title="Print on the office printer" context={`${label.title} ${number} · ${d.buyer?.name ?? ""}`} size="sm" onClose={() => setPrinting(null)} snap="half"
      footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void printIt(!!printing.ask)}><Printer size={15} aria-hidden="true" />{printing.ask ? "Yes, print it" : `Print ${printing.copies} ${printing.copies === 1 ? "copy" : "copies"}`}</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => setPrinting(null)}>Not now</button></DrawerFooter>}>
      <DrawerSection title={printing.ask ? "A long document" : "How many"}>
        {printing.ask ? <p className={css.note}>{printing.ask}</p> : <div className={css.fields}>
          <label className={styles.field}>Copies (1 to 20)<input type="number" inputMode="numeric" min={1} max={20} value={printing.copies}
            onChange={(e) => setPrinting({ ...printing, copies: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))) })} /></label>
          <label className={css.check}><input type="checkbox" checked={printing.twoSided} onChange={(e) => setPrinting({ ...printing, twoSided: e.target.checked })} />Print on both sides</label>
        </div>}
        <p className={css.note}>It goes to the office printer through the office computer; Billing → Printer shows when it printed, or why not.</p>
      </DrawerSection>
    </Drawer> : null}

    {askSent ? <Drawer title="Did you send it on WhatsApp?" context={`${label.title} ${number} · ${d.buyer?.name ?? ""}`} size="sm" onClose={() => setAskSent(null)} snap="half"
      footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void answerSent(true)}><CheckCheck size={15} aria-hidden="true" />Yes, I sent it</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => void answerSent(false)}>Not yet</button></DrawerFooter>}>
      <DrawerSection title="WhatsApp opened">
        <p className={css.note}>{askSent.mailed ? "The e-mail went. " : ""}Once you have pressed Send in WhatsApp, tap Yes: it is marked sent and the follow-up starts. Not yet keeps it as “Not sent yet” on Home.</p>
      </DrawerSection>
    </Drawer> : null}

    {choose ? <Drawer title="Make the tax invoice" context={`${d.number} · ${inr(d.total)}`} size="sm" onClose={() => setChoose(false)} snap="half"
      footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => { setChoose(false); make("invoice"); }}><FileOutput size={15} aria-hidden="true" />Invoice it as it is</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => { setChoose(false); revise(); }}><PencilLine size={14} aria-hidden="true" />Revise it first</button></DrawerFooter>}>
      <DrawerSection title="Is this the final quotation?">
        <p className={css.note}>The invoice copies the client, the project location and every line of {d.number} exactly. If the customer negotiated, revise the quotation first: it keeps its number and the approved copy is kept as a version.</p>
      </DrawerSection>
    </Drawer> : null}

    {pay ? <Drawer title="Record a payment" context={`${d.number} · balance ${inr(balance)}`} onClose={() => setPay(null)} snap="full"
      footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || pay.amount <= 0}
        onClick={async () => { if (await act(`erp/documents/${d.id}/payments`, pay, "Payment recorded")) setPay(null); }}>Record {inr(pay.amount + pay.tds)}</button>} />}>
      {data.bank.length ? <DrawerSection title="Bank credits that fit">
        <LineList label="Bank credits">{data.bank.map((b) => <LineRow key={b.key + b.variant} title={`${inr(b.amount)} · ${formatDate(b.date)}`} sub={[b.payer ?? "Payer not named", b.variant, b.reference].filter(Boolean).join(" · ")}
          selected={pay.bankLineKey === b.key}
          end={<button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPay({ ...pay, receivedOn: b.date, amount: b.amount, tds: Math.min(b.tds, balance - b.amount > 0 ? balance - b.amount : b.tds), reference: b.reference ?? "", bankLineKey: b.key })}>Use</button>} />)}</LineList>
      </DrawerSection> : null}
      {gstAccount && due && due.baseDue > 0 && due.gstDue > 0 ? <DrawerSection title="What arrived">
        <div className={css.radios} role="radiogroup" aria-label="What arrived">
          <label className={css.radio}><input type="radio" name="erp-pay-part" checked={pay.account !== gstAccount && pay.amount === due.baseDue} onChange={() => setPay({ ...pay, amount: due.baseDue, account: pay.account === gstAccount ? "" : pay.account })} />The amount without GST · {inr(due.baseDue)}</label>
          <label className={css.radio}><input type="radio" name="erp-pay-part" checked={pay.account === gstAccount && pay.amount === due.gstDue} onChange={() => setPay({ ...pay, amount: due.gstDue, tds: 0, account: gstAccount })} />The GST, into {gstAccount} · {inr(due.gstDue)}</label>
          <label className={css.radio}><input type="radio" name="erp-pay-part" checked={pay.amount === Math.max(0, balance) && pay.account !== gstAccount} onChange={() => setPay({ ...pay, amount: Math.max(0, balance), account: pay.account === gstAccount ? "" : pay.account })} />All of it · {inr(Math.max(0, balance))}</label>
        </div>
      </DrawerSection> : null}
      <DrawerSection title="Payment">
        <div className={css.fields}>
          <label className={styles.field}>Received on<DateField value={pay.receivedOn} max={data.today} onChange={(e) => setPay({ ...pay, receivedOn: e.target.value })} /></label>
          <label className={styles.field}>Amount received ₹<input inputMode="decimal" defaultValue={formatAmount(pay.amount).replace(/,/g, "")} key={`a${pay.amount}`} onChange={(e) => { const p = toPaise(e.target.value); if (p !== null) setPay({ ...pay, amount: p }); }} /></label>
          <label className={styles.field}>TDS deducted ₹<input inputMode="decimal" defaultValue={formatAmount(pay.tds).replace(/,/g, "")} key={`t${pay.tds}`} onChange={(e) => { const p = toPaise(e.target.value); if (p !== null) setPay({ ...pay, tds: p }); }} /></label>
          <label className={styles.field}>How<SelectField value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="bank">{free ? "Bank transfer (NEFT/RTGS/IMPS)" : "Bank transfer"}</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="other">Other</option></SelectField></label>
          {data.paymentAccounts?.accounts.length ? <label className={styles.field}>Paid into<SelectField value={pay.account} onChange={(e) => setPay({ ...pay, account: e.target.value })}><option value="">Not said (main account)</option>{data.paymentAccounts.accounts.map((a) => <option key={a} value={a}>{a === gstAccount ? `${a} (GST account)` : a}</option>)}</SelectField></label> : null}
          <label className={styles.field}>{free ? "UTR or reference" : "Reference"}<input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="UTR, cheque no." /></label>
          {/* KAZUK-FLOW G10: the proof of the payment (a screenshot of the UPI or bank transfer, or a PDF). */}
          <label className={styles.field}>Payment proof<input type="file" accept="image/png,image/jpeg,application/pdf" aria-label="Payment proof"
            onChange={(e) => { const f = e.target.files?.[0]; if (!f) { setPay({ ...pay, proof: null }); return; }
              if (f.size > 5 * 1024 * 1024) { notify({ id: "erp-proof", tone: "error", title: "The proof is up to 5 MB" }); return; }
              void asBase64(f).then((data) => setPay((x) => (x ? { ...x, proof: { mime: f.type, name: f.name, data } } : x))); }} />
            <span className={css.hint}>{pay.proof ? `${pay.proof.name} attached` : "A screenshot or PDF of the transfer"}</span></label>
        </div>
        {pay.bankLineKey ? <p className={css.note}>Matched to a bank credit: it won&apos;t be offered for another invoice.</p> : null}
        {gstAccount && pay.account === gstAccount ? <p className={css.note}>Money paid into the GST account covers this invoice&apos;s GST first. It is not counted as income.</p> : null}
      </DrawerSection>
    </Drawer> : null}
  </div>;
}


/** KAZUK-FLOW G7/G8: a reason from a fixed list and a one-line note (a new version's, a lost deal's). */
function ReasonDrawer({ title, context, reasons, ask, button, onSave, onClose }: { title: string; context: string; reasons: [string, string][]; ask: string; button: string;
  onSave: (reason: string, note: string) => Promise<unknown>; onClose: () => void }) {
  const [reason, setReason] = useState(""), [note, setNote] = useState("");
  return <Drawer title={title} context={context} size="sm" onClose={onClose} snap="half"
    footer={<DrawerFooter status={reason ? null : "Choose the reason"} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!reason}
      onClick={async () => { if (await onSave(reason, note)) onClose(); }}>{button}</button>} />}>
    <DrawerSection title={ask}>
      <div className={css.radios} role="radiogroup" aria-label={ask}>
        {reasons.map(([k, label]) => <label key={k} className={css.radio}><input type="radio" name="erp-reason" checked={reason === k} onChange={() => setReason(k)} />{label}</label>)}
      </div>
    </DrawerSection>
    <DrawerSection title="Note"><label className={styles.field}>One line (optional)<input maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Client asked 10% off" /></label></DrawerSection>
  </Drawer>;
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

/** BILLING (4 Nov 2026): the approved copies of a revised quotation, newest first, each with its filed PDF. */
export function Versions({ id, number, revision, versions, free = false }: { id: string; number: string | null; revision: number; versions: NonNullable<DocumentData["versions"]>; free?: boolean }) {
  // BILLING-WL: each copy by the name it was printed under (the first copy is the number alone, then R2, R3…).
  return <Disclosure summary="Versions" hint={`${number ?? ""} is now R${revision + 1}: ${versions.length} earlier ${free ? "sent" : "approved"} ${versions.length === 1 ? "copy" : "copies"} kept`}>
    <LineList label="Versions">{versions.map((x) => <LineRow key={x.revision} title={`V${x.revision + 1} · ${x.revision ? `${number ?? ""} R${x.revision + 1}` : `${number ?? ""} (first copy)`} · ${inr(x.total)}`}
      sub={[x.reasonKind ? `then ${x.reasonKind}` : null, x.sentAt ? `sent ${formatDate(x.sentAt.slice(0, 10))}` : null, x.approvedOn ? `${free ? "numbered" : "approved"} ${formatDate(x.approvedOn)}` : null, `revised ${when(x.filedAt)}${x.by ? ` by ${x.by}` : ""}`, x.reason].filter(Boolean).join(" · ")}
      end={x.pdf ? <a className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={`/api/v0/erp/documents/${id}/versions/${x.revision}/pdf`} download><Download size={13} aria-hidden="true" />PDF</a> : undefined} />)}</LineList>
  </Disclosure>;
}
