"use client";
// UI-SWEEP (owner, 10 Nov 2026: "The UX/UI of PR Studio etc. is too ugly to handle"; the empty state was one small card
// on a blank page). PR Studio's first run, Codex concept 1 "Show, then set up" with concept 2's one-step-at-a-time
// setup (reports/ui-sweep/concepts/pr-studio): what PR Studio does in four tiles, a sample month with example posts
// (marked as a sample), then "Set up your first brand" as the three-step brand wizard, its name filled in from the
// company profile. Saving opens the new brand's calendar.
import { useRouter } from "next/navigation";
import { CalendarDays, Megaphone, PenLine, ShieldCheck } from "lucide-react";
import { BrandWizard } from "./pipeline";
import css from "./first-run.module.css";

const WHAT = [
  { Icon: CalendarDays, title: "Calendar", text: "See every post for the month in one place." },
  { Icon: PenLine, title: "Posts", text: "Caption, hashtags and picture, ready in one kit." },
  { Icon: ShieldCheck, title: "Reviews", text: "Your team checks a post before it goes out." },
  { Icon: Megaphone, title: "Brand voice", text: "Every post sounds like your company." },
];
/** Example posts on the sample month: a day of the month and a kind (its colour). */
const SAMPLE = [
  { day: 4, title: "Site visit reel", kind: "video" }, { day: 7, title: "Festive offer", kind: "offer" }, { day: 11, title: "Client story", kind: "story" },
  { day: 14, title: "Team Friday", kind: "team" }, { day: 18, title: "Tips: home loans", kind: "tip" }, { day: 26, title: "Launch teaser", kind: "video" },
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The weeks of `today`'s month, Monday first; null for the days outside it. */
function monthWeeks(today: string): { label: string; weeks: (number | null)[][] } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
  const first = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7, days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return { label: `${MONTHS[m]} ${y}`, weeks: Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7)) };
}

export function PrFirstRun({ me, company, today }: { me: string | null; company: string | null; today: string }) {
  const router = useRouter();
  const { label, weeks } = monthWeeks(/^\d{4}-\d{2}/.test(today) ? today : new Date().toISOString().slice(0, 10));
  const post = (d: number | null) => d ? SAMPLE.find((s) => s.day === d) : undefined;
  // Round 1 (judge): the setup leads (it was below the fold); what PR Studio does and the sample month sit beside it.
  return <div className={css.run}>
    <section className={css.setup} aria-labelledby="pr-setup">
      <h2 id="pr-setup">Set up your first brand</h2>
      <p className={css.setupLead}>{company ? <>We filled in <b>{company}</b> from your company profile. Change anything, then press Next.</> : "Three short steps. Change anything later."}</p>
      <BrandWizard me={me} start={company ? { name: company } : undefined} onDone={(id) => router.push(`/pr?brand=${id}&view=strategy`)} />
    </section>
    <div className={css.side}>
      <section className={css.what} aria-labelledby="pr-what">
        <h2 id="pr-what">What PR Studio does</h2>
        <ul className={css.tiles}>{WHAT.map(({ Icon, title, text }) => <li key={title} className={css.tile}>
          <span className={css.tileIcon} aria-hidden="true"><Icon size={18} /></span><span className={css.tileText}><b>{title}</b><span>{text}</span></span>
        </li>)}</ul>
      </section>
      <section className={css.sample} aria-labelledby="pr-sample">
        <header className={css.sampleHead}><h2 id="pr-sample">{label}</h2><span className={css.sampleTag}>Sample</span></header>
        <table className={css.month} aria-describedby="pr-sample-note">
          <thead><tr>{WEEKDAYS.map((d) => <th key={d} scope="col">{d}</th>)}</tr></thead>
          <tbody>{weeks.map((w, i) => <tr key={i}>{w.map((d, j) => { const p = post(d); return <td key={j} data-out={d ? undefined : ""}>
            {d ? <span className={css.dayNo}>{d}</span> : null}{p ? <span className={css.chip} data-kind={p.kind} title={p.title}>{p.title}</span> : null}
          </td>; })}</tr>)}</tbody>
        </table>
        <ul className={css.legend} aria-label="Example posts">{SAMPLE.map((p) => <li key={p.day}><i data-kind={p.kind} aria-hidden="true" />{p.day} · {p.title}</li>)}</ul>
        <p id="pr-sample-note" className={css.sampleNote}>Example posts. Yours appear here once your brand is set up.</p>
        <p className={css.sampleNext}><b>What happens next:</b> PR Studio plans your first month of posts from your work. Your team checks each one before it goes out.</p>
      </section>
    </div>
  </div>;
}
