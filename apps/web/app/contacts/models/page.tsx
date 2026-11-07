import Link from "next/link";
import { Clapperboard, Info, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { count, plural } from "../../lib/format";
import { Avatar, Badge, Empty, Kpi, Message, Page, PageHeader, Panel, Tiles, styles } from "../../ui";
import { CONFIDENCE, inr, monthName, pct, type TalentBoard } from "./talent";
import css from "./models.module.css";

/** R55: which model gives how much benefit, which doesn't, and what works. A ranked board with its method and
 *  confidence on the page; costs only for leadership with finance grants. */
export default async function Models() {
  const r = await api<TalentBoard>("talent");
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  const ranked = d.models.filter((m) => m.rank !== null), days = d.models.reduce((n, m) => n + m.shootDays, 0);
  const costs = d.costVisible ? d.models.map((m) => m.cost?.total ?? 0) : [];
  const spent = costs.reduce((n, x) => n + x, 0);
  const perDay = d.costVisible ? ranked.map((m) => m.cost?.perDay).filter((x): x is number => !!x).sort((a, b) => a - b) : [];
  const median = perDay.length ? perDay[Math.floor(perDay.length / 2)] : null;
  const works = d.whatWorks.filter((w) => w.shootDays >= 3);
  const since = d.models.map((m) => m.first).filter((x): x is string => !!x).sort()[0] ?? null;
  return (
    <Page fit>
      <PageHeader title="Models" back={{ href: "/contacts?type=talent", label: "Contacts" }}
        context={[`${plural(ranked.length, "model")} ranked`, `${plural(days, "shoot day")}${since ? ` since ${monthName(since)}` : ""}`,
          d.baseline.returnRate !== null ? `${pct(d.baseline.returnRate)} of clients came back (company)` : null]}
        actions={<>{d.review ? <Link className={styles.btn} href="/review-data?kind=talent">Review {count(d.review)}</Link> : null}<Link className={styles.btn} href="/contacts?type=talent">All models</Link></>} />
      <Tiles count={d.costVisible ? 5 : 4} dense>
        <Kpi label="Models ranked" value={count(ranked.length)} note={`${count(d.models.length - ranked.length)} with one shoot day or none`} />
        <Kpi label="Shoot days" value={count(days)} note={`${pct(d.coverage.shoots ? d.coverage.linked / d.coverage.shoots : null)} linked to a project`} />
        <Kpi label="Clients came back" value={pct(d.baseline.returnRate)} note={`${count(d.baseline.clientsBack)} of ${count(d.baseline.clientsFollowed)} followed 90 days`} />
        <Kpi label="Videos from shoots" value={count(d.models.reduce((n, m) => n + m.videos, 0))} note={`${count(d.models.reduce((n, m) => n + m.delivered, 0))} delivered`} />
        {d.costVisible ? <Kpi label="Paid to models" value={inr(spent)} note={median ? `median ${inr(median)} a shoot day` : "fees, travel and extras"} /> : null}
      </Tiles>
      <div className={css.board} data-grow="">
        <Panel fill primary unit="models" title="Benefit ranking" sub={`${plural(ranked.length, "model")} with two or more shoot days`}
          tools={<details className={styles.why}><summary aria-label="How the ranking is worked out" title="How the ranking is worked out"><Info size={14} aria-hidden="true" /></summary><div className={styles.whyPanel}>{d.method.map((m) => <p key={m}>{m}</p>)}</div></details>}>
          {d.models.length ? <div className={styles.tableWrap}><table className={`${styles.table} ${css.rank}`}>
            <thead><tr><th className={styles.right}>#</th><th>Model</th><th>Benefit</th><th className={styles.right}>Shoot days</th><th className={styles.right} title="Clients who came back, of those followed for 90 days after their first shoot with this model">Clients back</th>
              <th className={styles.right} title="Model videos in the project folders of their shoots, per shoot day">Videos a day</th>{d.costVisible ? <th className={styles.right}>Cost a day</th> : null}<th>Last shoot</th></tr></thead>
            <tbody>{d.models.map((m) => (
              <tr key={m.id} data-new={m.rank === null ? "" : undefined}>
                <td className={`${styles.right} ${styles.num}`} data-label="Rank">{m.rank ?? "–"}</td>
                <td className={css.who} data-label="Model"><span className={css.person}><Avatar name={m.name} id={m.id} size={32} /><span>
                  <Link className={styles.cellLink} href={`/contacts/${m.id}`}>{m.name}</Link>
                  <span className={styles.cellSub} title={m.why}>{m.why}</span></span></span></td>
                <td data-label="Benefit">{m.score !== null ? <span className={css.score} title={`Benefit index ${m.score} of 100. ${CONFIDENCE[m.confidence].hint}.`}><i><em style={{ width: `${m.score}%` }} /></i><b>{m.score}</b></span> : null}
                  <Badge tone={CONFIDENCE[m.confidence].tone}>{CONFIDENCE[m.confidence].label}</Badge></td>
                <td className={`${styles.right} ${styles.num}`} data-label="Shoot days">{count(m.shootDays)}</td>
                <td className={`${styles.right} ${styles.num}`} data-label="Clients back">{m.clientsFollowed ? `${m.clientsBack} of ${m.clientsFollowed}` : <span className={styles.muted}>too early</span>}</td>
                <td className={`${styles.right} ${styles.num}`} data-label="Videos a day">{m.videosPerDay !== null ? m.videosPerDay.toFixed(1) : "–"}</td>
                {d.costVisible ? <td className={`${styles.right} ${styles.num}`} data-label="Cost a day">{inr(m.cost?.perDay)}</td> : null}
                <td className={styles.nowrap} data-label="Last shoot">{monthName(m.last)}</td>
              </tr>))}</tbody>
          </table></div> : <Empty icon={Clapperboard} first title="No shoots yet" text="The ranking fills in after the talent index reads the shoot coordinator's sheets." />}
        </Panel>
        <div className={css.side}>
          <Panel fill title="What works" sub="by language, segment and what was shot">
            {works.length ? <ul className={css.works}>{works.map((w) => (
              <li key={w.dimension + w.value}><span><b>{w.value}</b><small>{w.label} · {plural(w.shootDays, "shoot day")}</small></span>
                <span className={css.rate} title={w.note}>{w.clientsFollowed >= 5 ? pct(w.returnRate) : <small>{w.clientsFollowed ? `${w.clientsFollowed} followed` : "too early"}</small>}</span></li>))}</ul>
              : <Empty icon={Sparkles} first compact title="Not enough shoots yet" text="Groups need three shoot days to show here." />}
            <p className={css.note}>The share of clients who came back after a shoot of that kind{d.baseline.returnRate !== null ? `, against ${pct(d.baseline.returnRate)} for every shoot` : ""}. Shown once five clients have been followed for 90 days.</p>
          </Panel>
          <Panel title="Ad results" sub={d.adsConnected ? "from Meta ad names" : "not connected"}>
            <p className={css.note}>{d.adsConnected ? "Ads whose names carry a model's name count for that model: cost per lead and click rate appear on their profile." : "Meta ad-level results are not linked to Pulse yet (ad accounts send spend receipts only), so creative performance per model cannot be measured. When ads are connected and their names carry the model's name, cost per lead and click rate appear here."}</p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
