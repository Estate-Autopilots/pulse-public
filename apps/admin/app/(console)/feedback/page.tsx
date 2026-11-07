import { MessageSquareHeart } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { ago } from "@/app/lib/format";
import type { Feedback } from "@/app/lib/types";
import { Badge, Empty, Page, PageHeader, Panel, Unavailable } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: what people say in the apps (Settings → Send feedback), every organisation. Screenshots stay with each
// organisation; this lists the words.
export default async function FeedbackPage() {
  const r = await read<{ feedback: Feedback[] }>("platform/feedback");
  const rows = r.data?.feedback ?? [];
  return (
    <Page>
      <PageHeader title="Feedback" context={["Every organisation", `${rows.length} messages`]} />
      <Panel title="What people said">
        {r.error ? <Unavailable title="Feedback" reason={r.error} /> : !rows.length ? <Empty icon={MessageSquareHeart} title="No feedback yet" /> :
          <ul className={css.list}>{rows.map((f) => <li key={f.id} className={css.item}>
            <div>{f.body || <span className={css.muted}>No words{f.screenshot ? " (a screenshot)" : ""}</span>}
              <small>{f.person ?? "Someone"} · <Link href={`/organisations/${f.orgId}`}>{f.org}</Link> · {[f.platform, f.appVersion, f.page].filter(Boolean).join(" · ")} · {ago(f.createdAt)}</small></div>
            {f.status ? <Badge tone={f.status === "new" ? "warn" : "neutral"}>{f.status}</Badge> : null}
          </li>)}</ul>}
      </Panel>
    </Page>
  );
}
