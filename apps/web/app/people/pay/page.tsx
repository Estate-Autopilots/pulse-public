import { api, getMe } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { PeopleData } from "./model";
import { PayHome, type PolicyDocState } from "./home";
import { runTitle, type Runs } from "./payroll/model";
import { payDocState, type PolicyList } from "./policy-state";

/** COMP-A: People & pay, for leadership and HR (and managers, status only, when the company's pay policy says so).
 *  HR-PEOPLE (T1.1.4): one clear flow: how far pay is set up and the one button for the rest, the month's payroll, the
 *  pay policy everyone accepts, then one list (home.tsx). */
export default async function PeoplePay() {
  const [r, me] = await Promise.all([api<PeopleData>("comp/people"), getMe()]);
  if (!r.data) return <Message text={r.status === 403 ? "People & pay is for founders and HR. Your own pay is on My money." : r.error ?? "Not available"} />;
  const d = r.data;
  // COMP-B: the month's payroll, in one line, for founders and HR; and the pay policy document's state (HR-PEOPLE).
  const [runs, docs] = await Promise.all([d.can.read ? api<Runs>("comp/payroll").then((x) => x.data) : Promise.resolve(null), api<PolicyList>("hr/policies").then((x) => x.data)]);
  const open = runs?.runs.find((x) => ["draft", "checked"].includes(x.status)) ?? null;
  const payroll = !runs ? null : open ? { text: `${runTitle(open)}: ${open.status === "draft" ? (open.exceptions ? `${open.exceptions} exceptions to look at` : "HR checks it next") : "waiting for a founder"}`,
    href: `/people/pay/payroll/${open.id}`, act: open.status === "draft" ? runs.can.start : runs.can.approve }
    : { text: runs.runs[0] ? `${runTitle(runs.runs[0])} is ${runs.runs[0].status === "locked" ? "locked" : runs.runs[0].status}` : "No payroll yet", href: "/people/pay/payroll", act: false, none: !runs.runs[0] };
  const doc: PolicyDocState = payDocState(docs);
  return <Page fit>
    <PageHeader title="People & pay" back={{ href: "/people", label: "People" }}
      context={[`${d.people.filter((p) => p.current).length} on the team`, d.can.read ? "Pay, offers, probation and exits" : "Status and dates of your people"]} />
    <PayHome data={d} payroll={payroll} doc={doc} me={me.data?.person ?? null} />
  </Page>;
}
