import Link from "next/link";
import type { ReactNode } from "react";
import { Clapperboard, ExternalLink, Film, FolderSearch, Info } from "lucide-react";
import { count, dayYear, plural } from "../../lib/format";
import { Badge, Empty, Panel, styles } from "../../ui";
import { BASIS, CONFIDENCE, MEDIA_BASIS, inr, monthName, pct, type TalentProfile } from "../models/talent";
import css from "../models/models.module.css";

/** R55: a model's profile inside Contacts: what they bring (rank, clients who came back, videos, cost for leadership),
 *  their shoots with the project each was for and why, and their videos. */
export function TalentOverview({ t, details }: { t: TalentProfile; details: ReactNode }) {
  const r = t.row;
  const fees = t.fees ?? [];
  return (
    <div className={css.talentGrid} data-grow="" data-enter="">
      <div className={css.stack}>
        <Panel title="What they bring" sub={r?.rank ? `#${r.rank} of the ranked models` : r ? CONFIDENCE[r.confidence].label : "No shoots yet"}
          tools={<details className={styles.why}><summary aria-label="How this is worked out" title="How this is worked out"><Info size={14} aria-hidden="true" /></summary><div className={styles.whyPanel}>{t.method.map((m) => <p key={m}>{m}</p>)}</div></details>}>
          {r ? <>
            <div className={css.facts}>
              <div><small>Benefit index</small><b>{r.score ?? "–"}</b><Badge tone={CONFIDENCE[r.confidence].tone}>{CONFIDENCE[r.confidence].label}</Badge></div>
              <div><small>Shoot days</small><b>{count(r.shootDays)}</b><small>{r.first ? `${monthName(r.first)} – ${monthName(r.last)}` : "none dated"}</small></div>
              <div><small>Clients who came back</small><b>{r.clientsFollowed ? `${r.clientsBack} of ${r.clientsFollowed}` : "–"}</b><small>{r.clientsFollowed ? `${pct(r.returnRate)} · company ${pct(t.baseline.returnRate)}` : "none followed 90 days yet"}</small></div>
              <div><small>Model videos</small><b>{count(r.videos)}</b><small>{r.videosPerDay !== null ? `${r.videosPerDay.toFixed(1)} a shoot day · ${count(r.delivered)} delivered` : `${count(r.portfolio)} in the portfolio`}</small></div>
              <div><small>Projects · clients</small><b>{count(r.projects)} · {count(r.clients)}</b><small>{r.languages.join(", ") || "language not written"}</small></div>
              {t.costVisible && r.cost ? <div><small>Paid (fees, travel, extras)</small><b>{inr(r.cost.total)}</b><small>{inr(r.cost.perDay)} a shoot day{r.cost.travelShare ? ` · travel ${pct(r.cost.travelShare)}` : ""}</small></div>
                : <div><small>Ad results</small><b>{r.ads ? inr(r.ads.cpl) : "–"}</b><small>{r.ads ? "cost per lead" : t.adsConnected ? "no ad carries their name" : "ads not connected"}</small></div>}
            </div>
            <p className={css.why}>{r.why}</p>
          </> : <Empty icon={Clapperboard} first compact title="No shoots recorded" text="Shoots appear when the shoot coordinator's sheets name this model." />}
        </Panel>
        <Panel fill title="Projects and clients" sub={t.projects.length ? plural(t.projects.length, "project") : undefined}>
          {t.projects.length ? <ul className={styles.list}>{t.projects.map((p) => (
            <li key={p.id} className={styles.row}>
              <div className={styles.rowMain}>
                <Link href={`/projects/${p.id}`} className={styles.rowTitle}>{p.title}</Link>
                <span className={styles.rowMeta}>{[p.clientName, p.location, plural(p.shoots, "shoot"), p.videos ? plural(p.videos, "video") : null].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}</span>
              </div>
              <span className={styles.rowEnd}>{p.lastShoot ? dayYear(p.lastShoot) : null}</span>
            </li>))}</ul> : <Empty icon={FolderSearch} first compact title="No project linked yet" text="Shoots link to a project from the client in the shoot sheet or the dated videos in its folder; unsure ones wait in Review data." />}
        </Panel>
      </div>
      <div className={css.stack}>
        {t.aliases.length > 1 || t.review.length ? <Panel title="Written as" sub={t.review.length ? `${plural(t.review.length, "suggestion")} to review` : undefined}
          action={t.review.length ? { href: "/review-data?kind=talent", label: "Review" } : undefined}>
          <div className={css.chips}>{t.aliases.map((a) => <Badge key={a.key} tone={a.status === "confirmed" ? "success" : a.status === "review" ? "warning" : "neutral"}>{a.alias} · {a.seen}</Badge>)}</div>
        </Panel> : null}
        {details}
        {t.costVisible && fees.length ? <Panel title="Payments" sub={`${plural(fees.length, "line")} in the pay tracker`}>
          <p className={css.why}>Last paid {fees[0]?.shootOn ? dayYear(fees[0].shootOn) : monthName(fees[0]?.month ?? null)} · {inr(fees.reduce((n, f) => n + (f.total ?? 0), 0))} in all. Visible to leadership with finance grants; each view is logged.</p>
        </Panel> : null}
      </div>
    </div>
  );
}

export function TalentShoots({ t }: { t: TalentProfile }) {
  const fee = new Map<string, number>();
  for (const f of t.fees ?? []) for (const k of f.shootKeys) fee.set(k, (fee.get(k) ?? 0) + (f.total ?? 0) / Math.max(1, f.shootKeys.length));
  return (
    <Panel fill primary unit="shoots" title="Shoots" sub={`${plural(t.shoots.length, "shoot line")} · ${count(t.shoots.filter((s) => s.projectId).length)} linked to a project`}>
      {t.shoots.length ? <table className={`${styles.table} ${css.rank}`}>
        <thead><tr><th>Day</th><th>Project</th><th className={styles.hideSmall}>Place</th><th className={styles.hideSmall}>What</th><th className={styles.right}>Scripts</th>{t.costVisible ? <th className={styles.right}>Paid</th> : null}<th className={styles.hideSmall}>Source</th></tr></thead>
        <tbody>{t.shoots.map((s) => (
          <tr key={s.key}>
            <td className={styles.nowrap} data-label="Day">{s.shootOn ? dayYear(s.shootOn) : monthName(s.month)}</td>
            <td className={css.who} data-label="Project">{s.projectId ? <><Link className={styles.cellLink} href={`/projects/${s.projectId}`}>{s.projectName}</Link>
              <span className={styles.cellSub} title={`Linked by ${BASIS[s.projectBasis ?? "none"]}`}>{[s.clientName, `by ${BASIS[s.projectBasis ?? "none"]}${s.projectConfidence && s.projectConfidence < 1 ? ` (${pct(s.projectConfidence)})` : ""}`].filter(Boolean).join(" · ")}</span></>
              : <><span>{s.clientLabel ?? <span className={styles.muted}>Client not written</span>}</span><span className={styles.cellSub}>No project linked</span></>}</td>
            <td className={styles.hideSmall} data-label="Place">{s.locality ?? s.place ?? <span className={styles.muted}>Not written</span>}</td>
            <td className={styles.hideSmall} data-label="What">{[s.deliverable, s.language, s.segment].filter(Boolean).join(" · ") || <span className={styles.muted}>–</span>}</td>
            <td className={`${styles.right} ${styles.num}`} data-label="Scripts">{s.scripts ?? "–"}</td>
            {t.costVisible ? <td className={`${styles.right} ${styles.num}`} data-label="Paid">{fee.has(s.key) ? inr(fee.get(s.key)) : "–"}</td> : null}
            <td className={styles.hideSmall} data-label="Source" title={s.source?.file ? `${s.source.file}, tab “${s.source.sheet}”, row ${s.source.row}` : undefined}>{s.sources.map((x) => x === "pay_tracker" ? "Pay tracker" : "Shoot sheet").join(" + ")}</td>
          </tr>))}</tbody>
      </table> : <Empty icon={Clapperboard} first title="No shoots recorded" text="Shoots appear when the shoot coordinator's sheets name this model." />}
    </Panel>
  );
}

export function TalentMedia({ t }: { t: TalentProfile }) {
  return (
    <Panel fill primary unit="files" title="Photos and videos" sub={`${plural(t.media.length, "file")} · ${count(t.media.filter((m) => m.delivered).length)} delivered`}>
      {t.media.length ? <ul className={css.media}>{t.media.map((m) => (
        <li key={m.fileId}>
          {m.link ? <a href={m.link} target="_blank" rel="noreferrer" title={`Open “${m.name}” in Drive`}>{m.name} <ExternalLink size={12} aria-hidden="true" /></a> : <span>{m.name}</span>}
          <small>{[MEDIA_BASIS[m.basis] ?? m.basis, m.projectName, m.createdOn ? dayYear(m.createdOn) : null].filter(Boolean).join(" · ")}</small>
          <span>{m.delivered ? <Badge tone="success">Delivered</Badge> : <Badge>{m.kind === "video" ? "Video" : m.kind === "image" ? "Photo" : "Document"}</Badge>}</span>
        </li>))}</ul> : <Empty icon={Film} first title="No files yet" text="Portfolio folders, files named for the model and the model videos of their shoots appear here." />}
    </Panel>
  );
}
