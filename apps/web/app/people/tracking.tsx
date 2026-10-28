import Link from "next/link";
import { CalendarCheck, CircleCheck, CircleDashed, KeyRound, Link2, UploadCloud, UserRound } from "lucide-react";
import type { DeliveryAttributionSummary, DeliveryClaimReview, Editor, Insights, Period, PersonRow } from "../lib/api";
import { accountLabel, ago, count, isSevenDayPeriod, periodLabel, periodQuery, plural, range } from "../lib/format";
import { StaffId } from "../org-code";
import { attributionBuckets } from "../lib/editor-credit.mjs";
import { Split } from "../charts";
import { Avatar, Badge, Kpi, Panel, QueryTabs, Tiles, Why, styles } from "../ui";
import { ClaimsToConfirm } from "../delivery-claims";
import { editorTargetSummary, editorTargetTotal, type EditorTarget } from "./accounts/targets";
import { AccountClaimsReview, type UploaderAccountClaim } from "../account-claims/panels";
import editorStyles from "./accounts/editors.module.css";
import css from "./people.module.css";
import { W } from "../kit/word";

export type TargetedEditor = Editor & { targets: EditorTarget[] };

type Signal = { key: string; label: string; state: "live" | "blocked" | "planned"; note: string };
/** What a role is tracked by. Attendance is the same for everyone; the work signal follows the function. */
export function signalsFor(p: PersonRow, sharedOnly: boolean): Signal[] {
  const text = `${p.department ?? ""} ${p.role}`.toLowerCase(); const out: Signal[] = [];
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  if (has("creative", "production", "editor", "video", "design", "graphic", "shoot")) out.push(p.deliveries8w
    ? { key: "deliveries", label: "Deliveries", state: "live", note: `${plural(p.deliveries8w, "file")} in 8 weeks` }
    : { key: "deliveries", label: "Deliveries", state: "blocked", note: p.accounts.length ? "Linked account has no uploads" : sharedOnly ? "Uploads go through a shared login" : "No upload account linked" });
  if (has("performance", "pgs", "ads", "media buy")) out.push({ key: "campaigns", label: "Campaign results", state: "planned", note: "Meta Ads is not connected yet" });
  if (has("sales", "business development")) out.push({ key: "leads", label: "Leads and closures", state: "planned", note: "No lead source connected yet" });
  if (has("social")) out.push({ key: "posts", label: "Posts published", state: "planned", note: "No social account connected yet" });
  if (has("operations", "coordinator", "project")) out.push({ key: "tasks", label: "Projects and tasks", state: "planned", note: "Task trackers are not imported yet" });
  if (has("hr", "human")) out.push({ key: "hr", label: "Requests handled", state: "live", note: "From the HR desk" });
  if (has("founder", "ceo", "admin", "leadership") && !out.length) out.push({ key: "company", label: "Company view", state: "live", note: "Leadership page" });
  if (!out.length) out.push({ key: "none", label: "No work signal chosen", state: "planned", note: "Set the team to choose one" });
  return out;
}

/** One tracking view for the whole team: attendance for everyone, plus the signal that fits each role. */
export function Tracking({ people, insights, attendanceEnabled = false, view, editorAccounts, editorPeriod, editorAttribution, canReviewClaims = false, accountClaims = [], accountClaimsError, canReviewDeliveryClaims = false, pendingClaims = [], deliveryClaimsError }: {
  people: PersonRow[];
  insights: Insights;
  attendanceEnabled?: boolean;
  /** On a narrower window the team, accounts and claims are separate sub-tabs. */
  view: "people" | "accounts" | "claims";
  editorAccounts: TargetedEditor[] | null;
  editorPeriod: Period | null;
  editorAttribution: DeliveryAttributionSummary | null;
  canReviewClaims?: boolean;
  accountClaims?: UploaderAccountClaim[];
  accountClaimsError?: string;
  canReviewDeliveryClaims?: boolean;
  pendingClaims?: DeliveryClaimReview[];
  deliveryClaimsError?: string;
}) {
  const id = insights.identity; const current = people.filter((p) => p.status === "active");
  const sharedOnly = id.recent > 0 && id.credited === 0; const sharedPct = id.recent ? Math.round((id.shared / id.recent) * 100) : 0;
  const shared = insights.accounts.filter((a) => a.shared); const loose = insights.accounts.filter((a) => !a.shared && !a.personId);
  const signIn = insights.people;
  const explain = <>{count(id.shared)} of {count(id.recent)} files came from {plural(shared.filter((a) => a.recent).length || shared.length, "login")} that several people use. Drive records the login, so Pulse knows <b>what</b> was delivered and <b>when</b>, not <b>who</b> made it. Nobody is ranked or credited from this.</>;
  // One head row: the sub-tabs (narrower windows) and the shared-login issue with its three fixes. The longer
  // explanation sits in "Who delivered", so the team table keeps the window's height.
  return <>
    <div className={css.trackHead}>
      <div className={css.trackTabs}><QueryTabs sub base="/people" param="view" keep="tab=tracking" current={view} items={[{ key: "people", label: "People", count: current.length }, { key: "accounts", label: "Upload accounts", count: insights.accounts.length }, ...(canReviewClaims ? [{ key: "claims", label: "Claims to confirm", count: accountClaims.length }] : [])]} /></div>
      {id.shared && view !== "claims" ? (
        <section className={css.issue} aria-label="Shared login">
          <span className={css.issueIcon}><KeyRound size={16} strokeWidth={1.75} aria-hidden="true" /></span>
          <h3>{sharedPct === 100 ? "Every delivery" : `${sharedPct}% of deliveries`} in the last 8 weeks came through a shared login</h3>
          <Why detail={`${count(id.shared)} of ${count(id.recent)} files came from ${plural(shared.filter((a) => a.recent).length || shared.length, "login")} that several people use. Drive records the login, so Pulse knows what was delivered and when, not who made it.`} more="Nobody is ranked or credited from this." />
          <div className={css.fixes} role="group" aria-label="Three ways to fix this">
            <Link href="/people?tab=tracking&view=accounts" scroll={false} className={`${styles.btn} ${styles.btnSmall}`} title={`Link each person’s own account. ${loose.length ? `${plural(loose.length, "personal account")} already uploaded files and ${loose.length === 1 ? "is" : "are"} not linked to anyone.` : "Add the Google account each person uploads from to their record."}`}><Link2 size={13} aria-hidden="true" />Review accounts</Link>
            <Link href="/settings?tab=sign-in" className={`${styles.btn} ${styles.btnSmall}`} title={`One account per person. ${signIn.canSignIn} of ${signIn.headcount} people have a sign-in of their own. Give the rest one, and keep the shared logins for shoots only.`}><UserRound size={13} aria-hidden="true" />Give sign-in</Link>
            <span className={`${styles.btn} ${styles.btnSmall}`} aria-disabled="true" data-soon="" title="Coming next. A delivery uploaded from a project page is credited to the signed-in person, whichever Drive login stores it."><UploadCloud size={13} aria-hidden="true" />Upload through Pulse</span>
          </div>
        </section>
      ) : null}
    </div>
    <div className={`${styles.fit} ${css.trackFit}`} data-view={view} data-enter="">
      <Panel fill className={css.trackPeople} title="Everyone, by their own signals" sub={`${current.length} current`}
        tools={<Why detail={attendanceEnabled ? "Attendance and leave are tracked the same way for everyone. The work signal depends on the role: deliveries for creative and production, campaign results for performance, leads for sales." : "The work signal depends on the role: deliveries for creative and production, campaign results for performance, leads for sales."} more="A dashed signal is not connected yet; nothing is estimated in its place." />}>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>Person</th><th data-col="team"><W k="function" /> · <W k="team" lc /></th><th>Tracked by</th>{attendanceEnabled ? <th data-col="attendance">Attendance</th> : null}<th data-col="signin">Sign-in</th></tr></thead>
          <tbody>{current.map((p) => { const signals = signalsFor(p, sharedOnly); return (
            <tr key={p.id}>
              <td><Link href={`/people/${p.id}?tab=work`} className={styles.person}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={32} status /><span><span className={`${styles.cellLink} ${styles.nowrap}`}>{p.name}</span><span className={styles.cellSub}>{p.role}{p.role && p.userNo ? " · " : null}{p.userNo ? <StaffId no={p.userNo} /> : null}</span></span></Link></td>
              <td data-col="team" className={styles.nowrap}>{p.department ?? <span className={styles.muted}>Not set</span>}{p.pod ? <span className={styles.cellSub}>{p.pod}</span> : null}</td>
              <td><span className={css.signals}>{signals.map((s) => <span key={s.key} className={css.signal} data-state={s.state}>{s.state === "live" ? <CircleCheck size={12} aria-hidden="true" /> : <CircleDashed size={12} aria-hidden="true" />}{s.label}</span>)}</span>
                <span className={styles.cellSub} title={signals.map((s) => s.note).join(" · ")}>{signals.map((s) => s.note).join(" · ")}</span></td>
              {attendanceEnabled ? <td data-col="attendance" className={styles.nowrap}>{p.checkedIn ? <Badge tone="success"><CalendarCheck size={11} aria-hidden="true" />In today</Badge> : <span className={styles.muted}>Not in today</span>}</td> : null}
              <td data-col="signin" className={styles.nowrap}>{p.accounts.length || p.email ? <Badge tone="success">Own account</Badge> : <Badge>None yet</Badge>}</td>
            </tr>
          ); })}</tbody>
        </table></div>
      </Panel>
      <div className={css.trackSide}>
        {view === "claims" ? <AccountClaimsReview claims={accountClaims} error={accountClaimsError} /> : null}
        <div className={css.accountPanels}>
        {view === "accounts" ? <Panel title="Delivery credit" sub={editorAttribution ? `Last 30 days · ${count(editorAttribution.total_deliveries)} deliveries` : "Last 30 days"} className={css.whoDelivered}
          tools={<Why detail="Person-credited and shared-login deliveries are counted separately." more="Each share uses all deliveries as its denominator, including unresolved deliveries. Shared logins and unresolved deliveries receive no personal credit." />}>
          {editorAttribution?.total_deliveries ? <Tiles count={2} dense>{attributionBuckets(editorAttribution).map((bucket) => <Kpi key={bucket.key} label={bucket.label} value={count(bucket.count)} note={`${bucket.share} of all deliveries`} />)}</Tiles>
            : <p className={styles.panelFoot}>{editorAttribution ? "No deliveries were indexed in the last 30 days. Credit totals will appear when delivery data is available." : "The delivery credit summary is unavailable. Refresh to try again."}</p>}
        </Panel> : <Panel title="Who delivered" sub="Last 8 weeks" className={css.whoDelivered}>
          <Split unit="files" parts={[
            { key: "credited", label: "Credited to a person", value: id.credited, tone: "success" },
            { key: "shared", label: "Shared login", value: id.shared, tone: "warning" },
            { key: "unlinked", label: "Account not linked", value: id.unlinked, tone: "neutral" }]} />
          {id.shared ? <p className={css.explain}>{explain}</p> : null}
        </Panel>}
        <Panel fill title="Uploader accounts" sub={editorPeriod ? `${periodLabel(editorPeriod)} · ${range(editorPeriod.from, editorPeriod.to)}` : "Weekly target data unavailable"}
          tools={<Why detail="An account is linked from the person’s profile, under Accounts." more="A shared login is never credited to one person." />}>
          {editorAccounts ? <>
          <div className={editorStyles.desktopOnly}><div className={styles.tableWrap}><table className={styles.table} aria-label="Uploader accounts and weekly targets">
            <thead><tr><th scope="col">Account</th><th scope="col">Identity</th><th scope="col">{editorPeriod ? periodLabel(editorPeriod) : "Selected period"}</th><th scope="col">Target / week</th><th scope="col">Delivered · selected period</th><th scope="col">Gap · 7 days</th><th scope="col" className={styles.right}>All time</th><th scope="col" className={styles.right}>Drafts / finals</th><th scope="col">Latest activity</th></tr></thead>
            <tbody>{editorAccounts.map((a) => {
              const targetTotal = editorTargetTotal(a.targets);
              const reportWeek = Boolean(editorPeriod?.week && a.targets.length);
              const confirmedClaims = reportWeek ? a.targets.reduce((sum, target) => sum + target.claimed.drafts + target.claimed.finals, 0) : 0;
              const weeklyDelivered = reportWeek ? a.targets.reduce((sum, target) => sum + target.delivered.drafts + target.delivered.finals, 0) : a.thisWeek;
              const gap = !a.sharedLogin && editorPeriod && isSevenDayPeriod(editorPeriod) && a.targets.length > 0 && targetTotal.unconfigured === 0
                ? count(Math.max(0, targetTotal.value - weeklyDelivered)) : "—";
              const delivered = reportWeek ? weeklyDelivered : a.thisWeek;
              const targetSummary = a.sharedLogin ? "Shared login · no personal target" : a.holder_person_id ? editorTargetSummary(a.targets) : "No personal target";
              const link = `/people/accounts/${encodeURIComponent(a.account)}${editorPeriod ? periodQuery(editorPeriod) : ""}`;
              return <tr key={a.account}>
                <td><Link href={link} className={styles.cellLink}>{a.account}</Link></td>
                <td><Badge tone={a.identityVerified && !a.sharedLogin ? "success" : "neutral"}>{accountLabel(a)}</Badge></td>
                <td className={`${styles.nowrap} ${styles.num}`}>{count(delivered)}</td>
                <td className={styles.nowrap}>{targetSummary} {a.targets.some((target) => target.placeholder) && !a.sharedLogin && <Badge>placeholder target</Badge>}</td>
                <td className={styles.right}>{count(delivered)}{confirmedClaims ? <> <Badge>confirmed claim · {count(confirmedClaims)}</Badge></> : null}</td><td className={styles.right}>{gap}</td>
                <td className={styles.right}>{count(a.allTime)}</td><td className={styles.right}>{a.drafts} / {count(a.finals)}</td>
                <td className={styles.nowrap}>{ago(a.lastDelivery)}</td>
              </tr>;
            })}</tbody>
          </table></div></div>
          <section className={`${styles.cards} ${editorStyles.mobileOnly}`} aria-label="Uploader accounts">
            {editorAccounts.map((a) => {
              const targetTotal = editorTargetTotal(a.targets);
              const reportWeek = Boolean(editorPeriod?.week && a.targets.length);
              const confirmedClaims = reportWeek ? a.targets.reduce((sum, target) => sum + target.claimed.drafts + target.claimed.finals, 0) : 0;
              const weeklyDelivered = reportWeek ? a.targets.reduce((sum, target) => sum + target.delivered.drafts + target.delivered.finals, 0) : a.thisWeek;
              const gap = !a.sharedLogin && editorPeriod && isSevenDayPeriod(editorPeriod) && a.targets.length > 0 && targetTotal.unconfigured === 0
                ? count(Math.max(0, targetTotal.value - weeklyDelivered)) : "—";
              const delivered = reportWeek ? weeklyDelivered : a.thisWeek;
              const targetSummary = a.sharedLogin ? "Shared login · no personal target" : a.holder_person_id ? editorTargetSummary(a.targets) : "No personal target";
              const link = `/people/accounts/${encodeURIComponent(a.account)}${editorPeriod ? periodQuery(editorPeriod) : ""}`;
              return <article key={a.account} className={styles.card}>
                <div><Link href={link} className={styles.rowTitle}>{a.account}</Link>
                  <div className={styles.rowMeta}><Badge tone={a.identityVerified && !a.sharedLogin ? "success" : "neutral"}>{accountLabel(a)}</Badge><span>All time {count(a.allTime)}</span><span>Latest {ago(a.lastDelivery)}</span></div>
                </div>
                <dl className={editorStyles.metrics}>
                  <div><dt>Target / week</dt><dd><span>{targetSummary}</span>{a.targets.some((target) => target.placeholder) && !a.sharedLogin && <Badge>placeholder target</Badge>}</dd></div>
                  <div><dt>Delivered</dt><dd>{count(delivered)}{confirmedClaims ? <Badge>confirmed claim · {count(confirmedClaims)}</Badge> : null}<span className={styles.muted}>{a.drafts} drafts / {a.finals} finals</span></dd></div>
                  <div><dt>Gap · 7 days</dt><dd>{gap}</dd></div>
                </dl>
              </article>;
            })}
          </section>
          </> : <p className={styles.panelFoot}>Uploader account targets could not be loaded. Refresh to try again.</p>}
          <p className={styles.panelFoot}>Targets and placeholder flags come from each person’s weekly API. Shared logins have no personal target or gap. Type-level delivered and gap values appear on account profiles only when the weekly API matches the selected ISO week.</p>
        </Panel>
        {view === "accounts" && canReviewDeliveryClaims ? <ClaimsToConfirm claims={pendingClaims} error={deliveryClaimsError} /> : null}
        </div>
      </div>
    </div>
  </>;
}
