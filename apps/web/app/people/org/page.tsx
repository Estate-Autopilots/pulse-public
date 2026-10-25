import Link from "next/link";
import { api, teamWords } from "../../lib/api";
import { count } from "../../lib/format";
import { Message, Page, PageHeader, styles } from "../../ui";
import { OrgChart, type OrgData } from "./org-chart";

/** TASKS-3: the org chart. Who reports to whom, with pods and departments; HR and admins set lines and pod heads here and
 *  confirm what Pulse proposes. */
export default async function OrgPage() {
  const [r, words] = await Promise.all([api<OrgData>("org/chart"), teamWords()]);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  const placed = d.people.filter((p) => p.managerId).length;
  return <Page fit>
    <PageHeader title="Org chart" back={{ href: "/people", label: "Team" }}
      context={[`${count(d.people.length)} people`, `${count(placed)} with a manager`, `${d.pods.filter((p) => p.headId).length} of ${d.pods.length} pods with a head`, d.proposals.length ? `${d.proposals.length} proposed` : null]}
      actions={<Link className={styles.btn} href="/tasks?view=team">{words.team} dashboard</Link>} />
    <OrgChart data={d} />
  </Page>;
}
