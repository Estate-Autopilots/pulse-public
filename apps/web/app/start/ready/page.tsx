import Link from "next/link";
import { redirect } from "next/navigation";
import { api, getMe } from "../../lib/api";
import { Page, PageHeader } from "../../ui";
import { SEATS } from "../catalogue";
import { FirstRun, type Guide } from "../first-run";
import css from "../start.module.css";

export const metadata = { title: "How your team starts" };

/** ONBOARD-SELF: "how your team starts": the checklist, and what each seat does on its first day. */
export default async function Ready() {
  const me = (await getMe()).data;
  if (!me?.person) redirect("/login?next=/start/ready");
  const g = (await api<{ guide: Guide | null }>("account/onboarding")).data?.guide ?? null;
  return <Page><PageHeader title="How your team starts" context={[me.orgName ?? "Your company"]} />
    <div className={css.inPage}>
      {g ? <FirstRun initial={g} page /> : <p className={css.lede}>This company was set up by the Pulse team: ask your admin what to do first.</p>}
      <section className={css.seat} aria-labelledby="first-day">
        <b id="first-day">Everyone’s first day</b>
        <ol className={css.tips}>
          <li>Open the invitation e-mail and the link in it. Someone already on Pulse signs in with their account (password, Google or a sign-in code); someone new makes one.</li>
          <li>Install the phone app (<Link href="/apps">Apps</Link>) and sign in there too.</li>
          <li>Open My day: it lists what is due. Mark a task done when it is done.</li>
          <li>Talk about the work on the task itself, so everyone on it sees the answer.</li>
        </ol>
      </section>
      {SEATS.map((s) => <section key={s.key} className={css.seat} aria-label={s.label}>
        <div className={css.seatHead}><b>{s.label}</b></div><p className={css.muted}>{s.who}</p>
        <div className={css.seeWont}><div><p>Will see</p><ul>{s.sees.map((x) => <li key={x}>{x}</li>)}</ul></div><div><p>Won’t see</p><ul>{s.wont.map((x) => <li key={x}>{x}</li>)}</ul></div></div>
      </section>)}
      <div className={css.actions}><Link className={css.btn} href="/start/team">Invite more people</Link><Link className={`${css.btn} ${css.primary} ${css.grow}`} href="/">Open {me.orgName ?? "Pulse"}</Link></div>
    </div></Page>;
}
