import { Megaphone } from "lucide-react";

import { read } from "@/app/lib/api";
import { when } from "@/app/lib/format";
import type { Announcement } from "@/app/lib/types";
import { AnnouncementForm, EndAnnouncement } from "@/app/ui/actions";
import { Badge, Empty, Page, PageHeader, Panel, Unavailable } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: announcements (the Sales X-Ray admin's Product updates): a calm card for every signed-in person of every
// organisation, until it ends.
export default async function Updates() {
  const r = await read<{ announcements: Announcement[] }>("platform/announcements");
  const rows = r.data?.announcements ?? [];
  return (
    <Page wide>
      <PageHeader title="Announcements" context={["Every organisation", `${rows.filter((a) => a.live).length} live`]} />
      <div className={css.split}>
        <Panel title="New announcement" sub="Shown to signed-in people until it ends">
          <AnnouncementForm />
        </Panel>
        <Panel title="Announcements">
          {r.error ? <Unavailable title="Announcements" reason={r.error} /> : !rows.length ? <Empty icon={Megaphone} title="Nothing announced yet" /> :
            <ul className={css.list}>{rows.map((a) => <li key={a.id} className={css.item}>
              <div><b>{a.title}</b> {a.live ? <Badge tone="good">Live</Badge> : <Badge>Ended</Badge>} <Badge tone={a.tone === "warning" ? "warn" : a.tone === "success" ? "good" : "info"}>{a.tone}</Badge>
                {a.body ? <p>{a.body}</p> : null}
                <small>{a.audience === "admins" ? "Organisation admins" : "Everyone"} · from {when(a.startsAt)}{a.endsAt ? ` to ${when(a.endsAt)}` : ""} · {a.createdBy}{a.endedAt ? ` · ended ${when(a.endedAt)}` : ""}</small></div>
              {a.live ? <EndAnnouncement id={a.id} /> : null}
            </li>)}</ul>}
        </Panel>
      </div>
    </Page>
  );
}
