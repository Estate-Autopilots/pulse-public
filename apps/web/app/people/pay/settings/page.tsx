import { api, getMe, vocabulary } from "../../../lib/api";
import { teamHead } from "../../../lib/words.mjs";
import { Message, Page, PageHeader } from "../../../ui";
import { PolicyStudio, type Policy } from "./studio";
import { PayrollSettingsForm, type PayrollSettings } from "./payroll";
import { payDocState, type PolicyList } from "../policy-state";
import css from "../pay.module.css";

/** COMP-A: the company's pay policy; COMP-B: payroll's statutory basics. HR-PEOPLE (owner, 13 Nov 2026, T1.1.10–11):
 *  five plain answers that write the pay policy everyone accepts (studio.tsx); payroll basics under More settings. */
export default async function PayPolicy() {
  const [r, pay, docs, me, words] = await Promise.all([api<Policy>("comp/policy"), api<PayrollSettings>("comp/payroll/settings"), api<PolicyList>("hr/policies"), getMe(), vocabulary()]);
  if (!r.data) return <Message text={r.error ?? "Not available"} />;
  if (!r.data.canEdit) return <Message text="The pay policy is set by HR and founders. You can read it on My desk → Policies." />;
  return <Page>
    <PageHeader title="Pay policy" back={{ href: "/people/pay", label: "People & pay" }} context={["Check the five answers, then publish the policy."]} />
    <PolicyStudio policy={r.data} doc={payDocState(docs.data)} company={me.data?.orgName ?? ""} head={teamHead(words, { lc: true })}
      aside={pay.data ? <div className={css.policy} data-after=""><PayrollSettingsForm s={pay.data} /></div> : null} />
  </Page>;
}
