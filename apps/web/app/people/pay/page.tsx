import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { PeopleData } from "./model";
import { PayTable } from "./table";
import { runTitle, type Runs } from "./payroll/model";

/** COMP-A: People & pay, for leadership and HR (and managers, status only, when the company's pay policy says so). */
export default async function PeoplePay() {
  const r = await api<PeopleData>("comp/people");
  if (!r.data) return <Message text={r.status === 403 ? "People & pay is for founders and HR. Your own pay is on My money." : r.error ?? "Not available"} />;
  const d = r.data;
  // COMP-B: the month's payroll, in one line, for founders and HR.
  const runs = d.can.read ? (await api<Runs>("comp/payroll")).data : null;
  const open = runs?.runs.find((x) => ["draft", "checked"].includes(x.status)) ?? null;
  const payroll = !runs ? null : open ? { text: `${runTitle(open)}: ${open.status === "draft" ? (open.exceptions ? `${open.exceptions} exceptions to look at, then HR checks it` : "HR checks it next") : "waiting for a founder's approval"}`,
    href: `/people/pay/payroll/${open.id}`, act: open.status === "draft" ? runs.can.start : runs.can.approve }
    : { text: runs.runs[0] ? `${runTitle(runs.runs[0])} is ${runs.runs[0].status === "locked" ? "locked" : runs.runs[0].status}` : "No payroll run yet", href: "/people/pay/payroll", act: false };
  return <Page fit>
    <PageHeader title="People & pay" back={{ href: "/people", label: "People" }}
      context={[`${d.people.length} ${d.people.length === 1 ? "person" : "people"}`, d.can.read ? "Offers, pay, probation, pauses, claims and exits" : "Status and dates of your people"]} />
    <PayTable data={d} payroll={payroll} />
  </Page>;
}
