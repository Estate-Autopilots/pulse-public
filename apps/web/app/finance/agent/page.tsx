import { ShieldCheck } from "lucide-react";
import { api, getMe } from "../../lib/api";
import { Page } from "../../ui";
import { EmptyState, PageHeader } from "../../components/kit";
import { FinanceFrame } from "../nav";
import type { LiveState } from "../types";
import { AgentBadge, AgentDesk, type Overview, type Review } from "./desk";

/** FIN-AGENT: Finance → AI analyst. What the Finance AI employee read, what it wants a person to check (flags), its
 *  jobs with their time and cost, and the skills it learned. Leadership and the Finance role, as Finance → Entries. */
const LEDE: Record<string, string> = {
  check: "Send bank statements. It reads them and asks you only what it is unsure of.",
  jobs: "What it read, and what it found.",
  skills: "What it learned from your files and your choices.",
  send: "Add your bank statements here.",
};

export default async function FinanceAgentPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const view = ["check", "jobs", "skills", "send"].includes(q.view) ? q.view : "check";
  const flag = ["suspicious", "unclear_category", "missing_document", "possible_duplicate", "clear"].includes(q.flag) ? q.flag : "";
  const reviewQuery = new URLSearchParams(Object.entries({ flag, q: q.q ?? "", status: q.status ?? "" }).filter(([, v]) => v));
  const [o, live, review] = await Promise.all([
    api<Overview>("finance/agent"), api<LiveState>("finance/live"),
    view === "check" ? api<Review>(`finance/agent/review${reviewQuery.size ? `?${reviewQuery}` : ""}`) : Promise.resolve({ data: null }),
  ]);
  if (!o.data) return <Page calm><PageHeader eyebrow={["Finance"]} title="AI analyst" lede="The Finance AI employee reads statements and asks you about what it is unsure of." />
    <EmptyState icon={ShieldCheck} title="This is for leadership and the Finance role" text={o.status === 403 ? "Like Finance entries, it needs Finance access. Nothing was read." : o.error ?? "Not available"}
      action={(await getMe()).data?.financeAccess === false ? { href: "/", label: "Back to Home" } : { href: "/finance", label: "Open Finance" }} /></Page>;
  return <Page calm>
    <FinanceFrame tab="agent" q={q} live={live.data} actions={<AgentBadge o={o.data} />} lede={LEDE[view]} />
    <AgentDesk o={o.data} review={review.data ?? null} view={view} flag={flag} words={q.q ?? ""} />
  </Page>;
}
