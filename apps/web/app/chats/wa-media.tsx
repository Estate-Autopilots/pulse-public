"use client";
// WA-MEDIA (1100): what a file moved from WhatsApp shows or says, under it in the bubble: one line (its description)
// and, opened, the summary, the figures it carries (payments, ad funds, spend, leads, invoices), what the client said
// about a creative, quality notes, and on request everything read from it. One request per chat for the lines; the
// details of a file only when someone opens them. Read rules are the file's own (the server decides).
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { get } from "./net";
import { useOrgZone } from "../org-code";
import type { ChatMessage } from "./types";
import css from "./wa-media.module.css";

export type WaFigure = { kind: string; amount: number; unit: string; label?: string | null; status?: string | null };
export type WaMedia = { sha256: string; kind: string; class: string; alt: string | null; summary: string | null; figures: WaFigure[]; quality: string[];
  creative: { status: string; versionNo?: number | null; versions?: number | null } | null };
type About = { class: string; subclass?: string | null; summary?: string | null; text?: string | null; languages?: string[]; facts?: Record<string, unknown>;
  quality?: string[]; figures?: (WaFigure & { at?: string; period?: string | null; method?: string | null })[]; model?: string; analysedAt?: string };

/** The chat's imported files and what each is, keyed by message id (only chats with history moved from WhatsApp). */
export function useWaMedia(channelId: string, native: boolean, messages: ChatMessage[]) {
  const has = useMemo(() => native && messages.some((m) => m.imported && m.attachments.some((a) => a.wa)), [native, messages]);
  const [files, setFiles] = useState<Record<string, WaMedia>>({});
  useEffect(() => {
    if (!has) return;
    const ac = new AbortController();
    const t = setTimeout(() => { void get<{ files: Record<string, WaMedia> }>(`chats/${channelId}/wa-media`, ac.signal).then((d) => { if (!ac.signal.aborted && d?.files) setFiles(d.files); }).catch(() => {}); }, 120);
    return () => { clearTimeout(t); ac.abort(); };
  }, [channelId, has]);
  return files;
}

const CLASS: Record<string, string> = {
  ad_creative: "Ad creative", brochure_page: "Brochure page", cost_sheet: "Cost sheet", floor_plan: "Floor plan", site_photo: "Site photo", shoot_still: "Shoot still",
  lead_screenshot: "Leads screenshot", ads_manager_screenshot: "Ads dashboard", payment_screenshot: "Payment", invoice_receipt: "Invoice or receipt",
  chat_screenshot: "Chat screenshot", id_document: "Document photo", location_map: "Location map", brand_asset: "Brand asset", web_or_app_screenshot: "Web or app screen",
  brochure: "Brochure", price_list: "Price list", payment_schedule: "Payment schedule", floor_plans: "Floor plans", quotation: "Quotation", invoice: "Invoice", receipt: "Receipt",
  ad_platform_billing: "Ad billing", agreement_or_contract: "Agreement", proposal_or_pitch: "Proposal", report_or_analysis: "Report", lead_list: "Lead list",
  content_calendar_or_plan: "Plan", script_or_copy: "Script or copy", legal_or_rera: "Legal / RERA", kyc_or_id: "KYC document", letter_or_notice: "Letter", form: "Form",
  presentation: "Presentation", creative_or_design: "Design", reel_or_ad_edit: "Reel / ad video", raw_shoot_footage: "Shoot footage",
  site_or_sample_flat_walkthrough: "Walkthrough", drone_footage: "Drone footage", testimonial_or_interview: "Testimonial", construction_progress: "Construction progress",
  event_or_launch: "Event", screen_recording: "Screen recording", animation_or_3d_walkthrough: "3D walkthrough", script_or_reference_video: "Reference video",
  voice_note: "Voice note", audio_file: "Audio", other: "File", personal_or_other: "Video", project_render: "Project render",
};
export const classLabel = (c: string) => CLASS[c] ?? c.replace(/_/g, " ").replace(/^\w/, (x) => x.toUpperCase());
const FIG: Record<string, string> = { ad_spend: "Spend", leads: "Leads", cost_per_lead: "Cost per lead", impressions: "Impressions", reach: "Reach", clicks: "Clicks",
  payment: "Payment", ad_funds: "Ad funds", ad_balance: "Ad balance", invoice: "Invoice", quotation: "Quotation", receipt: "Receipt", price: "Price", budget: "Budget" };
const STATUS: Record<string, string> = { approved: "Approved", changes_requested: "Changes asked", discussed: "Discussed", no_response: "No answer" };
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-IN");
export const figureText = (f: WaFigure) => `${FIG[f.kind] ?? f.kind} ${f.unit === "inr" ? inr.format(f.amount) : f.unit === "pct" ? `${f.amount}%` : int.format(f.amount)}`
  + (f.status === "failed" ? " (failed)" : f.status === "pending" ? " (pending)" : "");

/** The line under a file, and its details when opened. */
export function WaMediaLine({ media }: { media: WaMedia }) {
  const [open, setOpen] = useState(false), [about, setAbout] = useState<About | null>(null), [more, setMore] = useState(false), [err, setErr] = useState(false);
  const figures = media.figures.slice(0, 4);
  const loadAbout = () => { setMore(true); if (about || err) return; void get<About>(`chats/whatsapp/files/${media.sha256}/about`).then(setAbout).catch(() => setErr(true)); };
  return <div className={css.line} data-wa-media={media.class}>
    <button type="button" className={css.head} aria-expanded={open} onClick={() => setOpen(!open)} title="What's in this file">
      <Sparkles size={12} aria-hidden="true" /><b>{classLabel(media.class)}</b>{media.alt ? <span>{media.alt}</span> : null}
      {media.creative ? <i className={css.status} data-status={media.creative.status}>{STATUS[media.creative.status] ?? media.creative.status}{media.creative.versions && media.creative.versions > 1 ? ` · v${media.creative.versionNo}/${media.creative.versions}` : ""}</i> : null}
      {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
    </button>
    {open ? <div className={css.body}>
      {media.summary ? <p>{media.summary}</p> : null}
      {figures.length ? <ul className={css.figures}>{figures.map((f, i) => <li key={i} title={f.label ?? undefined}>{figureText(f)}{f.label ? <small>{f.label}</small> : null}</li>)}</ul> : null}
      {media.quality.length ? <p className={css.quality}>Check: {media.quality.slice(0, 4).join("; ")}</p> : null}
      {!more ? <button type="button" className={css.more} onClick={loadAbout}>Everything read from it</button> : null}
      {more && err ? <p className={css.quality}>The details are not available.</p> : null}
      {more && about ? <AboutFile about={about} /> : more && !err ? <p className={css.muted}>Loading…</p> : null}
    </div> : null}
  </div>;
}

function AboutFile({ about }: { about: About }) {
  const zone = useOrgZone();
  const facts = Object.entries(about.facts ?? {}).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
  return <div className={css.about}>
    {about.subclass ? <p className={css.muted}>{about.subclass}{about.languages?.length ? ` · ${about.languages.join(", ")}` : ""}</p> : null}
    {about.text ? <details><summary>Text in it</summary><pre>{about.text}</pre></details> : null}
    {facts.map(([k, v]) => <details key={k}><summary>{k.replace(/_/g, " ")}</summary><Facts value={v} /></details>)}
    {about.figures?.length ? <details><summary>Figures</summary><ul className={css.figures}>{about.figures.map((f, i) => <li key={i}>{figureText(f)}{f.period ? <small>{f.period}</small> : null}{f.label ? <small>{f.label}</small> : null}</li>)}</ul></details> : null}
    <p className={css.muted}>Read by {about.model ?? "the analysis"}{about.analysedAt ? ` on ${new Date(about.analysedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone })}` : ""}; it can be wrong, so check the file.</p>
  </div>;
}

function Facts({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.every((x) => typeof x !== "object" || x === null) ? <p>{value.join(" · ")}</p>
    : <ol className={css.facts}>{value.slice(0, 40).map((x, i) => <li key={i}><Facts value={x} /></li>)}</ol>;
  if (typeof value === "object") return <dl className={css.facts}>{Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, " ")}</dt><dd><Facts value={v} /></dd></div>)}</dl>;
  return <span>{typeof value === "number" ? int.format(value) : String(value)}</span>;
}
