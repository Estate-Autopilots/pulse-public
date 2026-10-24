import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import { PolicyForm, type Policy } from "./policy";
import { PayrollSettingsForm, type PayrollSettings } from "./payroll";
import css from "../pay.module.css";

/** COMP-A: the company's pay policy: who approves, probation and notice, the salary structure, claims and the letters;
 *  COMP-B: payroll's statutory basics, attendance rules, pay day and bank file. */
export default async function PayPolicy() {
  const [r, pay] = await Promise.all([api<Policy>("comp/policy"), api<PayrollSettings>("comp/payroll/settings")]);
  if (!r.data) return <Message text={r.error ?? "Not available"} />;
  if (!r.data.canEdit) return <Message text="The pay policy is set by HR and founders." />;
  return <Page>
    <PageHeader title="Pay policy" back={{ href: "/people/pay", label: "People & pay" }} context={["How pay works in this company"]} />
    <PolicyForm policy={r.data} />
    {pay.data ? <div className={css.policy} data-after=""><PayrollSettingsForm s={pay.data} /></div> : null}
  </Page>;
}
