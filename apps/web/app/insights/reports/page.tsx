import Link from "next/link";
import { Download, FileText, LineChart } from "lucide-react";
import { api } from "../../lib/api";
import { Empty, Message, Page, PageHeader, QueryTabs, styles } from "../../ui";
import r from "./reports.module.css";
// WA-REPORT (1074): Insights → Reports, the contents of the company's analysis book: its parts (company, pods and segments,
// people, clients, projects, groups), search across every page, and the whole book as PDF or Markdown. Leadership and
// admins see every page; a colleague sees their own. ?tab=<part>&q=<words>.
type Item = { key: string; part: string; level: number; title: string; subtitle: string | null; summary: string | null; printed: { start: number; pages: number } | null; snippet: string | null };
type Index = { edition: { id: string; version: string; title: string; builtAt: string; pagesPrinted: number | null; chapters: number } | null; total: number; parts: Record<string, number>; items: Item[] };
const PARTS = [{ key: "company", label: "Company" }, { key: "pods", label: `Pods & segments` }, { key: "people", label: "People" }, { key: "clients", label: "Clients" }, { key: "projects", label: "Projects" }, { key: "groups", label: "Groups" }];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const words = (q.q ?? "").trim().slice(0, 120);
  const part = PARTS.some((p) => p.key === q.tab) ? q.tab! : "company";
  const res = await api<Index>(`reports?${new URLSearchParams({ ...(words ? { q: words } : { part }), limit: "500" })}`);
  if (res.error) return <Message text={res.error} />;
  const d = res.data!;
  if (!d.edition) return <Page><PageHeader title="Reports" /><Empty icon={FileText} title="No report loaded yet" text="The analysis book appears here once an edition is loaded." /></Page>;
  const lead = Object.keys(d.parts).length > 1;
  const built = new Date(d.edition.builtAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return <Page>
    <PageHeader title="Reports" context={[`The analysis of the client groups · edition ${d.edition.version}`, `${d.edition.chapters.toLocaleString("en-IN")} pages in Pulse${d.edition.pagesPrinted ? ` · ${d.edition.pagesPrinted.toLocaleString("en-IN")} printed` : ""} · built ${built}`]}
      actions={lead ? <>
        <Link className={styles.btn} href="/insights"><LineChart size={14} aria-hidden="true" />Client operations</Link>
        <a className={styles.btn} href="/api/v0/reports/export?book=pdf&inline=1" target="_blank" rel="noopener"><Download size={14} aria-hidden="true" />Book (PDF)</a>
        <a className={styles.btn} href="/api/v0/reports/export?book=md" download><Download size={14} aria-hidden="true" />Markdown</a></> : undefined} />
    {lead ? <>
      <form className={r.search} action="/insights/reports" method="get" role="search">
        <input name="q" defaultValue={words} placeholder="Search every page: a client, a colleague, “lead quality”, “funds”…" aria-label="Search the reports" />
        <button type="submit">Search</button>
      </form>
      {words ? null : <QueryTabs base="/insights/reports" current={part} items={PARTS.filter((p) => d.parts[p.key]).map((p) => ({ ...p, count: d.parts[p.key] }))} />}
    </> : <p className={r.lead}>Your own report: what the client groups show about your work, with the evidence. Leadership and admins read every report.</p>}
    {words ? <p className={r.lead}>{d.total.toLocaleString("en-IN")} {d.total === 1 ? "page" : "pages"} match “{words}”. <Link href="/insights/reports">Back to the contents</Link></p> : null}
    {d.items.length ? <ul className={r.items}>{d.items.map((i) => <li key={i.key} className={r.item} data-level={i.level}>
      <Link href={`/insights/reports/${i.key}`}>{i.title}</Link>
      {i.subtitle || i.printed ? <span className={r.itemSub}>{[i.subtitle, i.printed ? `printed p. ${i.printed.start}, ${i.printed.pages} ${i.printed.pages === 1 ? "page" : "pages"}` : null].filter(Boolean).join(" · ")}</span> : null}
      {i.snippet ? <span className={r.snippet}>…{i.snippet.replace(/[«»]/g, "")}…</span> : i.summary ? <span className={r.itemSum}>{i.summary.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").slice(0, 320)}</span> : null}
    </li>)}</ul> : <Empty icon={FileText} title={words ? "Nothing matches" : "No pages here"} text={words ? "Try fewer or different words." : undefined} />}
  </Page>;
}
