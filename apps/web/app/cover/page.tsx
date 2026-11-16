// KAZUK-REST slice 6 (F11): who covers while someone is on leave or working from home. The colleague asked accepts or
// declines here; a decline, or no answer in time, goes up to the person's manager and HR, who name someone else. The
// steps of the SOP are on the page, with the company's own hours.
import { api } from "../lib/api";
import { orgZone } from "../lib/brand-server";
import { Message, Page, PageHeader } from "../ui";
import { CoverBoard, type CoverData } from "./board";

export const metadata = { title: "Cover while away · Pulse" };

export default async function CoverPage() {
  const [r, zone] = await Promise.all([api<CoverData>("cover"), orgZone()]);
  if (!r.data) return <Page><PageHeader title="Cover while away" /><Message text={r.error} /></Page>;
  const d = r.data;
  const waiting = d.asked.filter((a) => a.status === "asked").length;
  return <Page>
    <PageHeader title="Cover while away" back={{ href: "/me?tab=leave", label: "My desk" }}
      context={[waiting ? `${waiting} ${waiting === 1 ? "colleague asks" : "colleagues ask"} you to cover` : "Nobody is waiting on you", `Answer within ${d.policy.hours} hours`]} />
    <CoverBoard data={d} zone={zone} />
  </Page>;
}
