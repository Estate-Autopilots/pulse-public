// WA-REPORT (1074): one page of the company's analysis book, drawn from its typed blocks: key numbers, text (the book's
// Markdown), bar and column charts, tables, evidence (each cited message opens in its chat; an excerpt shows only when
// the viewer may read that chat) and callouts. Links inside the text go to other report pages. Server-rendered.
import Link from "next/link";
import { Fragment, createElement, type ReactNode } from "react";
import { parseInline, parseMarkdown, type Block as MdBlock, type Inline } from "../../lib/markdown.mjs";
import { ReportBars, ReportCols, ReportKpis } from "./report-charts";
import r from "./reports.module.css";

type Tone = "neutral" | "warning" | "success" | "danger" | "accent";
export type ReportBlock =
  | { t: "kpis"; items: { label: string; value: string; unit?: string; note?: string; tone?: string }[] }
  | { t: "md" | "narrative"; md: string; model?: string }
  | { t: "callout"; tone?: string; md: string }
  | { t: "bars"; title?: string; sub?: string; unit?: string; total?: number; items: { label: string; value: number; sub?: string; href?: string }[] }
  | { t: "cols"; title?: string; sub?: string; suffix?: string; items: { label: string; value: number; tip?: string }[] }
  | { t: "table"; title?: string; sub?: string; cols: string[]; rows: string[][]; align?: ("l" | "r")[] }
  | { t: "evidence"; title?: string; items: { m: string; g?: string; at?: string; label?: string; note?: string }[] };
export type ReportPage = {
  key: string; part: string; level: number; title: string; subtitle: string | null; summary: string | null; blocks: ReportBlock[];
  subject: { kind: string; id: string } | null; printed: { start: number; pages: number } | null; hasPdf: boolean;
  evidence: Record<string, [string, string]>; links: Record<string, string>; excerpts: Record<string, string>;
  edition: { id: string; version: string; builtAt: string; pagesPrinted: number | null };
  prev: { key: string; title: string } | null; next: { key: string; title: string } | null;
};

const TONES = new Set(["neutral", "warning", "success", "danger", "accent"]);
const tone = (t?: string): Tone | undefined => t && TONES.has(t) ? t as Tone : undefined;

/** report:<key> → the page in Pulse; msg:<id> → the message in its chat (when this database has it). */
function hrefs(md: string, page: ReportPage) {
  return md.replace(/\]\(report:([a-z]+\/[A-Za-z0-9_-]+)\)/g, "](/insights/reports/$1)")
    .replace(/\]\(msg:(m_[0-9a-f]+)\)/g, (_, m: string) => page.evidence[m] ? `](/chats/whatsapp/${page.evidence[m][0]}?m=${page.evidence[m][1]})` : "]()");
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((n, i) => {
    switch (n.type) {
      case "text": case "confirm": return <Fragment key={i}>{n.text}</Fragment>;
      case "strong": return <strong key={i}><Inlines nodes={n.children} /></strong>;
      case "em": return <em key={i}><Inlines nodes={n.children} /></em>;
      case "code": return <code key={i} className={r.code}>{n.text}</code>;
      case "break": return <br key={i} />;
      case "link": return n.href.startsWith("/") ? <Link key={i} href={n.href}><Inlines nodes={n.children} /></Link> : <a key={i} href={n.href} target="_blank" rel="noopener noreferrer"><Inlines nodes={n.children} /></a>;
    }
  })}</>;
}

function Md({ blocks }: { blocks: MdBlock[] }) {
  return <>{blocks.map((b, i) => {
    switch (b.type) {
      case "heading": return createElement(`h${Math.min(6, b.level + 1)}`, { key: i, className: r.h }, <Inlines nodes={b.children} />);
      case "paragraph": return <p key={i}><Inlines nodes={b.children} /></p>;
      case "list": return createElement(b.ordered ? "ol" : "ul", { key: i, className: r.list, ...(b.ordered && b.start !== 1 ? { start: b.start } : {}) },
        b.items.map((it, k) => <li key={k}><Md blocks={it.children.length === 1 && it.children[0].type === "paragraph" ? [it.children[0]] : it.children} /></li>));
      case "table": return <div key={i} className={r.tableWrap}><table className={r.table}><thead><tr>{b.head.map((h, k) => <th key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}><Inlines nodes={h} /></th>)}</tr></thead>
        <tbody>{b.rows.map((row, k) => <tr key={k}>{row.map((c, j) => <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}><Inlines nodes={c} /></td>)}</tr>)}</tbody></table></div>;
      case "quote": return <blockquote key={i} className={r.quote}><Md blocks={b.children} /></blockquote>;
      case "rule": return <hr key={i} />;
      case "code": return <pre key={i} className={r.pre}>{b.text}</pre>;
    }
  })}</>;
}

const md = (text: string, page: ReportPage) => <div className={r.md}><Md blocks={parseMarkdown(hrefs(text, page)).blocks} /></div>;
const cell = (text: string, page: ReportPage) => <Inlines nodes={parseInline(hrefs(text, page))} />;
const when = (iso: string | undefined, zone: string) => iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone }) : "";

function BlockView({ b, page, zone }: { b: ReportBlock; page: ReportPage; zone: string }): ReactNode {
  switch (b.t) {
    case "kpis": return <ReportKpis items={b.items.map((k) => ({ ...k, tone: tone(k.tone) }))} />;
    case "md": return md(b.md, page);
    case "narrative": return <section className={r.narrative} aria-label="Analyst's reading">{md(b.md, page)}{b.model ? <p className={r.note}>Written by an AI model from the computed facts above (it saw ids, not names or messages); its numbers were checked against the facts.</p> : null}</section>;
    case "callout": return <div className={r.callout} data-tone={b.tone ?? "info"}>{md(b.md, page)}</div>;
    // INSIGHTS-2: charts in the Insights chart system (tips, PNG / CSV export, one palette).
    case "bars": return <ReportBars title={b.title} sub={b.sub} unit={b.unit} total={b.total} items={b.items} />;
    case "cols": return <ReportCols title={b.title} sub={b.sub} suffix={b.suffix} items={b.items} />;
    case "table": return <section className={r.block}>{b.title ? <h3 className={r.h}>{b.title}{b.sub ? <small> · {b.sub}</small> : null}</h3> : null}
      <div className={r.tableWrap}><table className={r.table}><thead><tr>{b.cols.map((c, k) => <th key={k} style={b.align?.[k] === "r" ? { textAlign: "right" } : undefined}>{c}</th>)}</tr></thead>
        <tbody>{b.rows.length ? b.rows.map((row, k) => <tr key={k}>{row.map((c, j) => <td key={j} style={b.align?.[j] === "r" ? { textAlign: "right" } : undefined}>{cell(String(c), page)}</td>)}</tr>) : <tr><td colSpan={b.cols.length} className={r.muted}>None.</td></tr>}</tbody></table></div></section>;
    case "evidence": return <section className={r.block}>{b.title ? <h3 className={r.h}>{b.title}</h3> : null}
      {b.items.length ? <ul className={r.evidence}>{b.items.map((e, k) => {
        const at = page.evidence[e.m]; const ex = page.excerpts[e.m];
        return <li key={`${e.m}-${k}`}><span className={r.evWhen}>{when(e.at, zone)}</span> <span>{e.label ? cell(e.label, page) : null}{e.note ? <span className={r.muted}> — {e.note}</span> : null}</span>{" "}
          {at ? <Link className={r.evLink} href={`/chats/whatsapp/${at[0]}?m=${at[1]}`}>Open the message</Link> : <code className={r.code}>{e.m}</code>}
          {ex ? <q className={r.excerpt}>{ex}</q> : null}</li>;
      })}</ul> : <p className={r.muted}>None.</p>}</section>;
  }
  return null;
}

/** The page body: summary and blocks (the header is the caller's: the report page, a person's or a client's tab). */
export function ReportBody({ page, zone }: { page: ReportPage; zone: string }) {
  return <article className={r.page} data-report-key={page.key}>
    {page.summary ? <div className={r.summary}>{md(page.summary, page)}</div> : null}
    {page.blocks.map((b, i) => <BlockView key={i} b={b} page={page} zone={zone} />)}
  </article>;
}

/** Export links: the page's Markdown, its PDF when the edition has one. */
export function ReportExports({ page }: { page: ReportPage }) {
  const k = encodeURIComponent(page.key);
  return <span className={r.exports}>
    <a className={r.btn} href={`/api/v0/reports/export?key=${k}&format=md`} download>Markdown</a>
    {page.hasPdf ? <a className={r.btn} href={`/api/v0/reports/export?key=${k}&format=pdf&inline=1`} target="_blank" rel="noopener">PDF</a> : null}
  </span>;
}
