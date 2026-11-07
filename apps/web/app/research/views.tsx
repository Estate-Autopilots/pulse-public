import Link from "next/link";
import { Activity, Info, Lock, Phone, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import {
  Badge,
  Empty,
  Kpi,
  Message,
  Pager,
  Panel,
  Tiles,
  Why,
  styles,
} from "../ui";
import { Sections } from "../sections";
import { RecordForm, type FieldDef } from "../records";
import type {
  AdData,
  CallsData,
  Count,
  GrowthData,
  Import,
  LeadData,
} from "./types";
import css from "./research.module.css";
import { SparseFacts } from "../charts";
import { sparse } from "../lib/sparse.mjs";
const num = (n: number) => n.toLocaleString("en-IN");
const cash = (n: number, currency = "INR") =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
const human = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export function SourceNote({
  imports,
  children,
}: {
  imports: Import[];
  children?: React.ReactNode;
}) {
  const asOf = imports[0]?.asOf;
  return (
    <p className={css.note}>
      Cleaned Drive sheets & mail · source through {asOf ?? "not imported"} ·{" "}
      {children ??
        "Historical observations; current connector health and balances are unknown."}
    </p>
  );
}
function Sparkline({ values, labels, label }: { values: number[]; labels: string[]; label: string }) {
  const few = sparse(values.map((n, i) => ({ n, i })), (p) => Math.abs(p.n));
  if (few) return <SparseFacts label={label} total={values.length} compare={false}
    facts={few.map((p) => ({ key: String(p.i), n: p.n, value: num(p.n), text: labels[p.i] }))} />;
  const max = Math.max(1, ...values);
  return (
    <svg
      className={css.spark}
      viewBox="0 0 300 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <line x1="0" y1="95" x2="300" y2="95" />
      <polyline
        points={values
          .map(
            (v, i) =>
              `${(i * 300) / Math.max(1, values.length - 1)},${95 - (v / max) * 85}`,
          )
          .join(" ")}
      />
    </svg>
  );
}
function Bars({ items, unit = "leads" }: { items: Count[]; unit?: string }) {
  const few = sparse(items, (p) => p.n);
  if (few) return <SparseFacts label={`Recorded ${unit} by category`} total={items.length} compare={false}
    facts={few.map((p) => ({ key: p.key, n: p.n, value: num(p.n), text: human(p.key), sub: unit }))} />;
  const max = Math.max(1, ...items.map((x) => x.n));
  return (
    <div className={css.barRows} data-items="">
      {items.map((x) => (
        <div
          key={x.key}
          className={css.barRow}
          title={`${human(x.key)}: ${num(x.n)} ${unit}`}
        >
          <span>{human(x.key)}</span>
          <span className={css.track}>
            <i style={{ width: `${(x.n / max) * 100}%` }} />
          </span>
          <b>{num(x.n)}</b>
        </div>
      ))}
    </div>
  );
}
function Funnel({ d }: { d: LeadData }) {
  const s = d.summary,
    items = [
      ["With call notes", s.noted],
      ["Interested or further", s.interested + s.plannedPlus],
      ["Visit planned or further", s.plannedPlus],
      ["Visit done or booked", s.visited],
      ["Booked", s.booked],
    ] as const;
  const draw = items.filter(([, n]) => n > 0).length >= 3;
  return (
    <section className={css.card}>
      <h3>Recorded outcome funnel</h3>
      <div className={css.funnel}>
        {items.map(([label, n]) => (
          <div key={label} className={css.funnelRow}>
            {draw ? <div
              className={css.funnelBar}
              style={{ width: `${(n / Math.max(1, s.noted)) * 48}%` }}
            /> : null}
            <span>
              {label}
              <br />
              <b>{num(n)}</b> ·{" "}
              {s.noted ? ((n / s.noted) * 100).toFixed(1) : "—"}%
            </span>
          </div>
        ))}
      </div>
      <p className={css.note}>
        Among {num(s.noted)} leads with call notes (
        {s.leads ? ((s.noted / s.leads) * 100).toFixed(1) : 0}% coverage).
        Nested stages; bookings are included in visits. Free-text
        classifications may undercount outcomes.
      </p>
    </section>
  );
}
function Heat({ d }: { d: LeadData }) {
  const few = sparse(d.hours, (p) => p.n);
  const max = Math.max(1, ...d.hours.map((x) => x.n));
  return (
    <section className={css.card}>
      <h3>When leads arrive · IST</h3>
      {few ? <SparseFacts label="When leads arrive, IST" total={d.hours.length} compare={false} empty="No timestamped leads in this period."
        facts={few.map((p) => ({ key: `${p.dow}-${p.hour}`, n: p.n, value: num(p.n), text: `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][p.dow - 1]} ${p.hour}:00 IST`, sub: "leads" }))} /> : <div className={css.heat}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span className={css.heatLabel} key={h}>
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => (
          <span key={day} style={{ display: "contents" }}>
            <span className={css.heatLabel}>{day}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const n =
                d.hours.find((x) => x.dow === i + 1 && x.hour === h)?.n ?? 0;
              return (
                <span
                  tabIndex={0}
                  key={h}
                  className={css.heatCell}
                  style={{ opacity: n ? 0.2 + (0.8 * n) / max : 0.06 }}
                  title={`${day} ${h}:00 IST · ${num(n)} leads`}
                  aria-label={`${day} ${h}:00 IST: ${num(n)} leads`}
                />
              );
            })}
          </span>
        ))}
      </div>}
      <p className={css.note}>
        {num(d.summary.dated)} timestamped buyer leads; undated rows excluded.
        Colour shows observed count, never caller productivity.
      </p>
    </section>
  );
}
export function LeadView({
  d,
  mode = "leads",
  project,
}: {
  d: LeadData;
  mode?: string;
  project?: string;
}) {
  const s = d.summary;
  const title = mode === "creatives" ? "Creative response" : "Buyer leads";
  const summary = (
    <Tiles count={4}>
      <Kpi
        label="Buyer leads"
        value={num(s.leads)}
        note={`${num(s.dated)} dated · all imported history`}
      />
      <Kpi
        label="With call notes"
        value={num(s.noted)}
        note={`${s.leads ? ((s.noted / s.leads) * 100).toFixed(1) : 0}% of buyer leads · partial coverage`}
      />
      <Kpi
        label="Recorded visits / bookings"
        value={num(s.visited)}
        note={`${num(s.booked)} bookings included · not CRM totals`}
      />
      <Kpi
        label="Buyer leads · last 7 days"
        value={num(s.last7)}
        note={`Today: ${num(s.today)} · IST calendar; last 7 rolling days`}
      />
    </Tiles>
  );
  const items =
    mode === "creatives"
      ? [
          {
            label: "Creative types",
            content: (
              <Panel
                className={css.grow}
                title="Lead response by creative type"
                sub="Observed lead volume; per-ad spend is unavailable"
              >
                <Pager unit="creative types">
                  <table className={css.table}>
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Leads</th>
                        <th>With notes</th>
                        <th>Visit planned or further</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.creative.map((x) => (
                        <tr key={x.key}>
                          <td>{human(x.key)}</td>
                          <td>{num(x.n)}</td>
                          <td>{num(x.noted)}</td>
                          <td>
                            {x.rate.value === null ? (
                              <Badge>Insufficient notes (under 40)</Badge>
                            ) : (
                              <>
                                <b>{(x.rate.value * 100).toFixed(1)}%</b>
                                <small>
                                  Approx. 95% interval{" "}
                                  {(x.rate.low! * 100).toFixed(1)}–
                                  {(x.rate.high! * 100).toFixed(1)}%; n=
                                  {x.noted}
                                </small>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Pager>
                <p className={css.note}>
                  Beta-binomial estimate: 40 prior observations at this
                  development’s mean. Association only; no creative or employee
                  credit without an explicit ad/version link.
                </p>
              </Panel>
            ),
          },
          {
            label: "Hooks & language",
            content: (
              <div className={css.double}>
                <section className={css.card}>
                  <h3>Hook number · observed leads</h3>
                  <Pager>
                    <Bars items={d.hooks} />
                  </Pager>
                  <p className={css.note}>
                    Unequal ad delivery can explain unequal lead counts. This is
                    not a test of which hook is better.
                  </p>
                </section>
                <section className={css.card}>
                  <h3>Language tags</h3>
                  <Bars items={d.languages} />
                  <p className={css.note}>
                    Untyped names stay untagged; no language is inferred from
                    buyer identity.
                  </p>
                </section>
              </div>
            ),
          },
          {
            label: "Refresh planning",
            content: (
              <section className={css.card}>
                <h3>
                  <RefreshCw size={18} />
                  Refresh planning
                </h3>
                <p>
                  Among 29 ads in the research sample, half the observed leads
                  arrived within a median 22 days. A 21-day review is a planning
                  rule, not a live fatigue measurement.
                </p>
                <Empty
                  icon={Info}
                  title="Confirm live ads to schedule refreshes"
                  text="Sheet rows do not prove an ad is still live. Pulse needs an ad/version link, first-lead date and current delivery state before creating a refresh task."
                  action={
                    project
                      ? {
                          href: `/tasks?project=${project}`,
                          label: "Open project tasks",
                        }
                      : undefined
                  }
                />
                <p className={css.note}>
                  No stale-ad alarm or budget allocator is inferred from
                  historical lead volume.
                </p>
              </section>
            ),
          },
        ]
      : [
          {
            label: "Volume",
            content: (
              <div className={css.double}>
                <section className={css.card}>
                  <h3>{title} over time</h3>
                  {d.daily.length ? (
                    <>
                      <Sparkline
                        values={d.daily.map((x) => x.n)}
                        labels={d.daily.map((x) => x.day)}
                        label={d.daily
                          .map((x) => `${x.day}: ${x.n} leads`)
                          .join("; ")}
                      />
                      <div className={css.caption}>
                        <span>{d.daily[0].day}</span>
                        <span>{d.daily.at(-1)?.day}</span>
                      </div>
                    </>
                  ) : (
                    <Empty
                      icon={Activity}
                      title="No dated buyer leads matched"
                      text="Unmatched project keys and undated leads stay visible in company coverage."
                    />
                  )}
                  <p className={css.note}>
                    Latest 60 recorded days; dates with no rows are omitted, so
                    the line is observation order rather than a continuous daily
                    forecast.
                  </p>
                </section>
                <section className={css.card}>
                  <h3>Platform mix</h3>
                  <Bars items={d.platforms} />
                  <p className={css.note}>
                    Sheet platform anchors; missing values remain “Not
                    recorded”. Agency and hiring forms are excluded.
                  </p>
                </section>
              </div>
            ),
          },
          {
            label: "Recorded days",
            content: (
              <Panel
                className={css.grow}
                title="Buyer lead observations by day"
                sub="Latest 60 recorded days · IST · dates without rows omitted"
              >
                {" "}
                <Pager unit="recorded days">
                  <table className={css.table}>
                    <thead>
                      <tr>
                        <th>Day · IST</th>
                        <th>Buyer leads</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.daily.map((x) => (
                        <tr key={x.day}>
                          <td>{x.day}</td>
                          <td>{num(x.n)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Pager>
              </Panel>
            ),
          },
          {
            label: "Outcomes",
            content: (
              <div className={css.double}>
                <Funnel d={d} />
                <section className={css.card}>
                  <h3>Recorded call persistence</h3>
                  <Pager>
                    <table className={css.table}>
                      <thead>
                        <tr>
                          <th>Recorded touches</th>
                          <th>With notes</th>
                          <th>Visit planned or further</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.touches.map((x) => (
                          <tr key={x.key}>
                            <td>{x.key === "5" ? "5+" : x.key}</td>
                            <td>{num(x.n)}</td>
                            <td>
                              {((x.visits / Math.max(1, x.n)) * 100).toFixed(1)}
                              %
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Pager>
                  <p className={css.note}>
                    Among leads with call notes. Interested buyers may get more
                    calls, so this does not prove that calls caused visits.
                  </p>
                </section>
              </div>
            ),
          },
          {
            label: "Timing & answers",
            content: (
              <div className={css.double}>
                <Heat d={d} />
                <section className={css.card}>
                  <h3>Stated buyer budget</h3>
                  <Pager>
                    <Bars items={d.budget} />
                  </Pager>
                  <p className={css.note}>
                    {num(d.budget.reduce((n, x) => n + x.n, 0))} buyer leads
                    with a budget answer, in lakh INR. Lower bound of a stated
                    range; not verified purchasing power.
                  </p>
                </section>
              </div>
            ),
          },
          {
            label: "Visit timing",
            content: (
              <section className={css.card}>
                <h3>Stated visit timing</h3>
                <Pager>
                  <Bars items={d.intent} />
                </Pager>
                <p className={css.note}>
                  Explicit buyer answers only; missing timing is unknown.
                  Historical intent needs re-qualification.
                </p>
              </section>
            ),
          },
          {
            label: "Follow-up",
            content: (
              <section className={css.card}>
                <h3>Follow-up opportunities</h3>
                <Tiles count={4}>
                  {(["untouched", "oneTouch", "weekend", "night"] as const).map(
                    (key, i) => (
                      <Kpi
                        key={key}
                        label={
                          [
                            "No recorded touch",
                            "One recorded touch",
                            "Said this weekend",
                            "Night arrival",
                          ][i]
                        }
                        value={num(d.queues[key])}
                        note={
                          [
                            "Missing call logs may hide contact",
                            "Consider a second call",
                            "Historical intent; re-qualify",
                            "22:00–06:00 IST",
                          ][i]
                        }
                        href={
                          project
                            ? `/projects/${project}?tab=calls&queue=${key}`
                            : undefined
                        }
                      />
                    ),
                  )}
                </Tiles>

                <p>
                  Queues overlap and exclude completed visits, bookings, invalid
                  leads, brokers, buyers who already bought and explicit
                  disinterest.
                </p>
                <p className={css.note}>
                  Historical candidates, not overdue commitments. Contact
                  identifiers are absent; authorised teams open the original
                  sheet to follow up.
                </p>
                {project ? (
                  <Link
                    className={styles.btn}
                    href={`/projects/${project}?tab=calls`}
                  >
                    Open project follow-up
                  </Link>
                ) : null}
              </section>
            ),
          },
          ...(d.notices
            ? [
                {
                  label: "Pipes & funding",
                  content: (
                    <Panel
                      className={css.grow}
                      title="Lead pipes & funding notices"
                      sub="Observed history; recent means last 7 calendar days"
                    >
                      <Pager unit="notice types">
                        <table className={css.table}>
                          <thead>
                            <tr>
                              <th>Signal</th>
                              <th>All history</th>
                              <th>Last 7 days</th>
                              <th>Last observed</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.notices.map((x) => (
                              <tr key={x.kind}>
                                <td>{human(x.kind)}</td>
                                <td>{num(x.total)}</td>
                                <td>{num(x.recent ?? 0)}</td>
                                <td>{x.last}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Pager>
                      <p className={css.note}>
                        No current account balance, unresolved incident state or
                        live delivery spend is supplied. A historical pause is
                        not an active alert. Confirm permissions and current
                        integrations in Settings.
                      </p>
                      <Link href="/settings?tab=accounts" className={css.link}>
                        Review connected accounts
                      </Link>
                    </Panel>
                  ),
                },
              ]
            : []),
        ];
  return (
    <div className={css.body} data-grow="">
      <SourceNote imports={d.imports}>
        {d.scope ?? "Buyer leads only; agency and hiring forms excluded."}
      </SourceNote>

      <Sections
        param="researchView"
        items={[{ label: "Summary", content: summary }, ...items]}
        initial={1}
      />
    </div>
  );
}
export function DataHealthView({ d }: { d: LeadData }) {
  const s = d.summary;
  const typed = d.creative
    .filter((x) => x.key !== "unknown")
    .reduce((n, x) => n + x.n, 0);
  const cards = (
    <>
      {[
        ["Development key recovered", s.mapped, s.leads],
        ["Usable creation time", s.dated, s.leads],
        ["Creative type recovered", typed, s.leads],
        ["Call outcome recorded", s.noted, s.leads],
      ].map(([label, n, total]) => (
        <section className={css.card} key={String(label)}>
          <h3>{label}</h3>
          <div className={css.value}>
            {Number(total)
              ? ((Number(n) / Number(total)) * 100).toFixed(1)
              : "0"}
            %
          </div>
          <p className={css.note}>
            {num(Number(n))} / {num(Number(total))} buyer leads · all imported
            history
          </p>
          <p className={css.note}>
            Recovered from cleaned sheet anchors and explicit answer
            vocabularies. This does not imply complete source coverage.
          </p>
        </section>
      ))}
      <section className={css.card}>
        <h3>Engagement links</h3>
        <div className={css.value}>
          {d.coverage?.linked ?? 0} / {d.coverage?.engagements ?? 0}
        </div>
        <p className={css.note}>
          Exact Drive folder links;{" "}
          {Number(d.coverage?.engagements ?? 0) -
            Number(d.coverage?.linked ?? 0)}{" "}
          unmatched source folders. Ambiguous identities stay unmerged.
        </p>
        <Link className={styles.btn} href="/review-data">
          Review missing details
        </Link>
      </section>
      <section className={css.card}>
        <h3>Creative IDs & live sources</h3>
        <div className={css.value}>Unknown</div>
        <p className={css.note}>
          No verified ad/version link or current platform polling. Historical ad
          names cannot prove CID coverage. Ad balances, exact creative CPL and
          speed-to-lead remain unavailable.
        </p>
        <Link
          className={styles.btn}
          href="/finance?tab=ad-spend&adView=Account+mapping"
        >
          Review ad-account mapping
        </Link>
      </section>
    </>
  );
  const children = cards.props.children;
  const coverage = children[0];
  return (
    <div className={css.body} data-grow="">
      <SourceNote imports={d.imports}>
        Coverage is measured from buyer leads. Missing source values remain
        unknown.
      </SourceNote>
      <Sections
        param="researchView"
        items={[
          {
            label: "Lead coverage",
            content: <div className={css.double}>{coverage}</div>,
          },
          {
            label: "Source links",
            content: <div className={css.double}>{children.slice(1)}</div>,
          },
        ]}
      />
    </div>
  );
}

export function GrowthView({
  d,
  pipeline = false,
}: {
  d: GrowthData;
  pipeline?: boolean;
}) {
  const measures = pipeline
    ? [
        ["ownLeads", "Agency prospects"],
        ["outbound", "Outbound case studies"],
        ["replies", "Replies"],
        ["newClients", "First-time clients"],
        ["invoices", "Invoices"],
      ]
    : [
        ["engagements", "New engagements"],
        ["newClients", "First-time clients"],
        ["activeClients", "Active clients · rolling 3 months"],
        ...(d.finance ? [["spend", "Ad payments · INR"]] : []),
        ["leads", "Buyer leads"],
        ["invoices", "Invoices"],
      ];
  const cards = measures.map(([key, label]) => {
    const values = d.growth.map((x) => Number(x[key] ?? 0)),
      delta = (pipeline ? (d.pipelineDeltas ?? d.deltas) : d.deltas)[key],
      last = values.at(-1) ?? 0;
    return (
      <section key={key} className={css.card}>
        <h3>
          {key === "spend" ? <Lock size={14} /> : null}
          {label}
        </h3>
        <div className={css.value}>
          {key === "spend" ? cash(last) : num(last)}
        </div>
        <Badge tone={delta !== null && delta < -25 ? "warning" : "neutral"}>
          {delta === null || delta === undefined
            ? "No comparable prior observations"
            : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% · 3 vs 3 months`}
        </Badge>
        <Sparkline
          values={values}
          labels={d.growth.map((x) => `${x.month} · ${label}`)}
          label={d.growth
            .map(
              (x) =>
                `${x.month}: ${key === "spend" ? cash(Number(x[key])) : num(Number(x[key]))} ${label}`,
            )
            .join("; ")}
        />
        <div className={css.caption}>
          <span>{d.growth[0]?.month.slice(0, 7)}</span>
          <span>{d.growth.at(-1)?.month.slice(0, 7)}</span>
        </div>
        <p className={css.note}>
          {key === "spend"
            ? "Deduplicated Meta receipt payments; currencies separate."
            : key === "activeClients"
              ? "Distinct clients with an engagement in that or the two preceding months."
              : key === "invoices"
                ? "Distinct invoice numbers; amounts unavailable."
                : key === "newClients"
                  ? "Earliest observed engagement; not account creation date."
                  : key === "leads" || key === "ownLeads"
                    ? "Timestamped, deduplicated sheet observations."
                    : "Observed source records per calendar month."}
        </p>
      </section>
    );
  });
  return (
    <div className={css.body} data-grow="">
      <SourceNote imports={d.imports}>{d.window}</SourceNote>
      {!pipeline ? (
        <div className={css.notice} data-alarm={d.alarm}>
          <Activity size={18} />
          <b>{d.alarm ? "Growth needs attention" : "Growth pulse"}</b>
          <span>
            {
              Object.values(d.deltas).filter((x) => x !== null && x < -25)
                .length
            }{" "}
            measures fell over 25% across the last 3 vs previous 3 complete
            months. Source coverage can also change.
          </span>
        </div>
      ) : null}
      <Sections
        param="researchView"
        items={[
          {
            label: pipeline ? "Prospects & replies" : "Engagements & clients",
            content: <div className={css.grid}>{cards.slice(0, 3)}</div>,
          },
          {
            label: pipeline ? "Clients & invoices" : "Payments & outcomes",
            content: <div className={css.grid}>{cards.slice(3)}</div>,
          },
        ]}
      />
    </div>
  );
}
export async function CallsView({
  project,
  query,
}: {
  project: string;
  query: Record<string, string>;
}) {
  const result = await api<CallsData>(
    `projects/${project}/calls?${new URLSearchParams(query)}`,
  );
  if (result.error) return <Message text={result.error} />;
  const d = result.data;
  if (!d) return null;
  return (
    <div className={css.body} data-grow="">
      <p className={css.note}>
        De-identified historical leads. Counts come from sheet call notes;
        queues overlap. Manual corrections survive source replay.
      </p>
      <div className={css.notice}>
        {[
          ["untouched", "No recorded touch"],
          ["oneTouch", "One touch"],
          ["weekend", "This weekend"],
          ["night", "Night leads"],
        ].map(([key, label]) => (
          <Link
            key={key}
            className={styles.btn}
            href={`/projects/${project}?tab=calls&queue=${key}`}
          >
            {label}
          </Link>
        ))}
      </div>
      <Panel
        className={css.grow}
        title={`${human(d.queue)} · ${num(d.total)} candidates`}
      >
        <Pager unit="leads">
          <table className={css.table}>
            <thead>
              <tr>
                <th>Lead reference</th>
                <th>Created · IST</th>
                <th>Calls</th>
                <th>Outcome</th>
                <th>Source / correction</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.id.slice(0, 8)}
                    <small>{human(x.intent ?? "Intent not recorded")}</small>
                  </td>
                  <td>
                    {x.created
                      ? new Date(x.created).toLocaleString("en-GB", {
                          timeZone: "Asia/Kolkata",
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : "Date unknown"}
                  </td>
                  <td>{x.touches}</td>
                  <td>
                    {human(x.outcome ?? "Not recorded")}
                    {x.manual ? <Badge>Edited in Pulse</Badge> : null}
                  </td>
                  <td>
                    <a
                      className={css.link}
                      href={`https://docs.google.com/spreadsheets/d/${x.sheetRef}/edit`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open source sheet
                    </a>
                    {d.canWrite ? (
                      <RecordForm
                        path={`research/leads/${x.id}/touch`}
                        title="Correct call observation"
                        label="Record outcome"
                        extra={{ projectId: project }}
                        fields={[
                          {
                            key: "touches",
                            label: "Recorded call attempts",
                            type: "number",
                            required: true,
                          },
                          {
                            key: "outcome",
                            label: "Strongest observed outcome",
                            type: "select",
                            required: true,
                            options: [
                              "unreachable",
                              "interested",
                              "visit_planned",
                              "visit_done",
                              "booked",
                              "not_interested",
                              "invalid",
                              "already_bought",
                              "broker",
                              "location_mismatch",
                              "budget_mismatch",
                            ].map((value) => ({ value, label: human(value) })),
                          },
                        ]}
                        values={{
                          touches: String(x.touches),
                          outcome: x.outcome,
                        }}
                        note="Sheet notes are a partial history. Record an observed outcome only; do not infer a visit from interest."
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Pager>
        {!d.rows.length ? (
          <Empty
            icon={Phone}
            title="No candidates in this queue"
            text="Try another follow-up queue."
          />
        ) : null}
      </Panel>
      <div className={css.caption}>
        <span>Source page {d.page + 1} · up to 50 observations</span>
        {d.page > 0 ? (
          <Link
            href={`/projects/${project}?tab=calls&queue=${d.queue}&page=${d.page - 1}`}
          >
            Previous 50
          </Link>
        ) : null}
        {(d.page + 1) * 50 < d.total ? (
          <Link
            href={`/projects/${project}?tab=calls&queue=${d.queue}&page=${d.page + 1}`}
          >
            Next 50
          </Link>
        ) : null}
      </div>
    </div>
  );
}
/** The ad spend views, for a page to lay out (Finance → Money out → Ad spend picks some of them). */
export function adSpendParts(d: AdData) {
  const inr = d.totals.find((x) => x.currency === "INR");
  const mapped = d.accounts.filter((x) => x.projectKey || x.clientId);
  const monthKeys = [
    ...new Set(
      d.months.filter((x) => x.currency === "INR").map((x) => x.month),
    ),
  ];
  const monthly = monthKeys.map((month) => ({
    month,
    funds: d.months
      .filter(
        (x) => x.currency === "INR" && x.kind === "funds" && x.month === month,
      )
      .reduce((n, x) => n + x.amount, 0),
    billed: d.months
      .filter(
        (x) => x.currency === "INR" && x.kind === "billed" && x.month === month,
      )
      .reduce((n, x) => n + x.amount, 0),
  }));
  const sorted = d.accounts.toSorted((a, b) => b.amount - a.amount),
    total = sorted.reduce((n, x) => n + x.amount, 0);
  const pareto = sorted.map(
    (_, i) =>
      (sorted.slice(0, i + 1).reduce((n, x) => n + x.amount, 0) /
        Math.max(1, total)) *
      100,
  );
  const mappingFields: FieldDef[] = [
    {
      key: "projectId",
      label: "Engagement / development",
      type: "select",
      options: d.projects.map((p) => ({
        value: p.id,
        label: p.name,
      })),
    },
    {
      key: "clientId",
      label: "Client (optional when project linked)",
      type: "select",
      options: d.clients.map((c) => ({
        value: c.id,
        label: c.name,
      })),
    },
  ];
  const items = [
          {
            label: "Summary",
            content: (
              <Tiles count={4}>
                <Kpi
                  label="Observed ad payments · INR"
                  value={inr ? cash(inr.amount) : "—"}
                  note={`${num(inr?.n ?? 0)} deduplicated receipts · ${inr?.first ?? "—"} → ${inr?.last ?? "—"}`}
                />
                <Kpi
                  label="Accounts mapped"
                  value={`${mapped.length} / ${d.accounts.length}`}
                  note="Client or development key; uncertain links stay unmatched"
                />
                <Kpi
                  label="Matched-development CPL"
                  value={d.cpl.length ? cash(d.benchmark) : "—"}
                  note={`${d.cpl.length} eligible developments · weighted benchmark`}
                />
                <Kpi
                  label="Account runway"
                  value="Unknown"
                  note="No verified balance or daily delivery spend"
                />
              </Tiles>
            ),
          },
          {
            label: "Monthly payments",
            content: (
              <div className={css.double}>
                <section className={css.card}>
                  <h3>Receipt payments by month · INR</h3>
                  <Sparkline
                    values={monthly.map((x) => x.funds + x.billed)}
                    labels={monthly.map((x) => `${x.month} · INR`)}
                    label={monthly
                      .map(
                        (x) =>
                          `${x.month}: funds ${cash(x.funds)}, billed ${cash(x.billed)}`,
                      )
                      .join("; ")}
                  />

                  <p className={css.note}>
                    Transaction-ID deduplication removes mailbox copies. Receipt
                    day is payment or billed-range end, not email arrival.
                    Funding and billing methods describe receipt categories.
                  </p>
                </section>
                <section className={css.card}>
                  <h3>Currency separation</h3>
                  {d.totals.map((x) => (
                    <div key={x.currency}>
                      <b>{cash(x.amount, x.currency)}</b>
                      <p className={css.note}>
                        {num(x.n)} receipts · {x.first} → {x.last}
                      </p>
                    </div>
                  ))}
                  <h3>Funding guard</h3>
                  <p>
                    Review current balance in Ads Manager before the weekend. A
                    seven-day plan requires a measured delivery run-rate.
                  </p>
                  <p className={css.note}>
                    Historical pause and low-funds notices are in Dashboard →
                    Leads & pipes. No Telegram incident is sent from a stale
                    notice.
                  </p>
                  <Link
                    className={styles.btn}
                    href="/dashboard?tab=research&researchView=Pipes+%26+funding"
                  >
                    Open observed notices
                  </Link>
                </section>
              </div>
            ),
          },
          {
            label: "Payment records",
            content: (
              <Panel
                className={css.grow}
                title="Monthly receipt payments · INR"
                sub="Deduplicated mail receipts; payments are not current platform spend"
              >
                {" "}
                <Pager unit="months">
                  <table className={css.table}>
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th>Prepaid funds</th>
                        <th>Postpaid billed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthly.map((x) => (
                        <tr key={x.month}>
                          <td>{x.month.slice(0, 7)}</td>
                          <td>{cash(x.funds)}</td>
                          <td>{cash(x.billed)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Pager>
              </Panel>
            ),
          },
          {
            label: "Account mapping",
            content: (
              <Panel
                className={css.grow}
                title="Ad accounts"
                sub={`${d.accounts.length - mapped.length} unmatched · manual mappings win on replay`}
              >
                <Pager unit="accounts">
                  <table className={css.table}>
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Mapped to</th>
                        <th>Receipts</th>
                        <th>Last receipt</th>
                        <th>INR payments</th>
                        <th>Mapping</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.accounts.map((x) => (
                        <tr key={x.accountId}>
                          <td
                            title={`${x.accountId} · ${x.months} observed months`}
                          >
                            {x.name}
                          </td>
                          <td title={`${x.alerts} historical funding notices`}>
                            {x.projectName ??
                              x.projectKey ??
                              x.clientName ??
                              "Unmatched"}
                            {x.manual ? <Badge>Manual</Badge> : null}
                          </td>
                          <td>{x.receipts}</td>
                          <td>{x.last ?? "Unknown"}</td>
                          <td
                            title={`${x.inrReceipts} INR receipts; other currencies excluded`}
                          >
                            {cash(x.amount)}
                          </td>
                          <td>
                            {d.permissions.write ? (
                              <RecordForm
                                path="money/ad-account"
                                title="Map ad account"
                                label="Map account"
                                extra={{ accountId: x.accountId }}
                                fields={mappingFields}
                                values={{
                                  projectId: x.projectId,
                                  clientId: x.clientId,
                                }}
                                note="Choose the correct engagement. Development-wide cost calculations use its source key. Clearing both links confirms the account as unmatched; future imports preserve that choice."
                              />
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Pager>
              </Panel>
            ),
          },
          {
            label: "Cost per lead",
            content: (
              <Panel
                className={css.grow}
                title="Cost per lead by development"
                sub="Matched spend months only · INR ≥5,000 and ≥50 buyer leads"
              >
                <Pager unit="developments">
                  <table className={css.table}>
                    <thead>
                      <tr>
                        <th>Development</th>
                        <th>Payments / leads</th>
                        <th>Observed CPL</th>
                        <th>
                          Adjusted CPL{" "}
                          <Why detail="Adjusted CPL = (payments + 50 × company benchmark) ÷ (leads + 50). Approximate Poisson bands; prior exposure equals 50 leads. Payment timing differs from ad delivery. Visit costs are upper bounds because call-note coverage is partial." />
                        </th>
                        <th>Cost / recorded visit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.cpl.map((x) => (
                        <tr key={x.project_key}>
                          <td>
                            {x.projectId ? (
                              <Link href={`/projects/${x.projectId}?tab=leads`}>
                                {human(x.project_key)}
                              </Link>
                            ) : (
                              human(x.project_key)
                            )}
                            <small>{human(x.segment)}</small>
                          </td>
                          <td>
                            {cash(x.spend)}
                            <small>
                              {num(x.leads)} buyer leads · {x.noted} with notes
                            </small>
                          </td>
                          <td>{cash(x.cpl)}</td>
                          <td>
                            {x.estimate
                              ? cash(x.estimate.value)
                              : "Insufficient"}
                            {x.estimate ? (
                              <small>
                                Approx. 95% band {cash(x.estimate.low)}–
                                {cash(x.estimate.high)}
                              </small>
                            ) : null}
                          </td>
                          <td>
                            {x.visitCost
                              ? cash(x.visitCost)
                              : "No recorded visit"}
                            <small>
                              {x.visits} visit done / booked · upper bound
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Pager>
              </Panel>
            ),
          },
          {
            label: "Segments & outcomes",
            content: (
              <div className={css.double}>
                <section className={css.card}>
                  <h3>Payment-derived CPL by segment</h3>
                  <Pager>
                    <table className={css.table}>
                      <thead>
                        <tr>
                          <th>Segment</th>
                          <th>CPL</th>
                          <th>Leads / developments</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.segments
                          .toSorted((a, b) => a.cpl - b.cpl)
                          .map((x) => (
                            <tr key={x.key}>
                              <td>{human(x.key)}</td>
                              <td>{cash(x.cpl)}</td>
                              <td>
                                {num(x.leads)} / {x.n}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </Pager>
                  <p className={css.note}>
                    Same eligible development sample and matching months as the
                    CPL table; sum of payments ÷ sum of leads.
                  </p>
                </section>
                <section className={css.card}>
                  <h3>CPL vs recorded visit intent</h3>
                  {(() => {
                    const points = d.cpl.filter((x) => x.rate.value !== null);
                    const max = Math.max(1, ...points.map((x) => x.cpl));
                    return (
                      <svg
                        className={css.scatter}
                        viewBox="0 0 460 250"
                        role="img"
                        aria-label="Payment-derived CPL versus adjusted visit-planned-or-further rate among noted leads"
                      >
                        <line x1="40" y1="220" x2="445" y2="220" />
                        <line x1="40" y1="20" x2="40" y2="220" />
                        {points.map((x) => (
                          <circle
                            key={x.project_key}
                            cx={40 + (x.cpl / max) * 400}
                            cy={220 - x.rate.value! * 195}
                            r={Math.min(14, 4 + Math.sqrt(x.leads) / 20)}
                            tabIndex={0}
                            role="img"
                            aria-label={`${human(x.project_key)}: ${cash(x.cpl)} CPL; ${(x.rate.value! * 100).toFixed(1)}% visit planned or further, n=${x.noted}`}
                          />
                        ))}
                        <text x="40" y="245">
                          ₹0 CPL
                        </text>
                        <text x="345" y="245">
                          {cash(max)} CPL
                        </text>
                        <text x="4" y="220">
                          0%
                        </text>
                        <text x="4" y="25">
                          100%
                        </text>
                      </svg>
                    );
                  })()}
                  <p className={css.note}>
                    At least 40 noted leads per dot. Visit intent is
                    beta-binomial adjusted with 40 prior notes; circle size
                    shows buyer leads. Different segments and delivery budgets
                    confound comparison.
                  </p>
                </section>
              </div>
            ),
          },
          {
            label: "Account shares",
            content: (
              <Panel
                className={css.grow}
                title="Account payment shares · INR"
                sub="Ranked deduplicated receipts; unmatched accounts included"
              >
                {" "}
                <Pager unit="largest accounts">
                  <table className={css.table}>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Account</th>
                        <th>Payments · INR</th>
                        <th>Cumulative share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((x, i) => (
                        <tr key={x.accountId}>
                          <td>{i + 1}</td>
                          <td>{x.name}</td>
                          <td>{cash(x.amount)}</td>
                          <td>{pareto[i].toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Pager>
              </Panel>
            ),
          },
          {
            label: "Concentration",
            content: (
              <section className={css.card}>
                <h3>Account payment concentration · INR</h3>
                <Sparkline
                  values={pareto}
                  labels={sorted.map((_, i) => `${i + 1} accounts · cumulative %`)}
                  label={`Cumulative payment share, descending accounts. ${sorted.map((x, i) => `${i + 1} accounts: ${pareto[i].toFixed(1)}%`).join("; ")}`}
                />
                <div className={css.caption}>
                  <span>Largest account</span>
                  <span>{sorted.length} accounts · 100%</span>
                </div>
                <p className={css.note}>
                  Pareto curve, sorted by observed INR payment amount. Includes
                  unmatched accounts; no inferred client revenue.
                </p>
              </section>
            ),
          },
  ];
  return { note: <SourceNote imports={d.imports}>{d.disclaimer}</SourceNote>, items };
}
export function AdSpendView({ d }: { d: AdData }) {
  const { note, items } = adSpendParts(d);
  return (
    <div className={css.body} data-grow="">
      {note}
      <Sections param="adView" initial={1} items={items} />
    </div>
  );
}
export async function RenewalsView() {
  const result = await api<{
    items: {
      id: string;
      name: string;
      type: string;
      engagements: number;
      last: string | null;
      gap: number | null;
      health: string;
    }[];
    rule: string;
  }>("research/clients");
  if (result.error) return <Message text={result.error} />;
  const d = result.data;
  if (!d) return null;
  return (
    <div className={css.body} data-grow="">
      <p className={css.note}>
        {d.rule} Missing dates stay unknown; this is a review queue rather than
        a fitted churn model.
      </p>
      <Panel
        className={css.grow}
        title="Client renewals"
        sub="Repeat clients due first; then observed recency"
      >
        <Pager unit="clients">
          <table className={css.table}>
            <thead>
              <tr>
                <th>Client</th>
                <th>Type</th>
                <th>Engagements</th>
                <th>Last engagement</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {d.items
                .toSorted(
                  (a, b) =>
                    (a.health === "due" ? -1 : 0) -
                      (b.health === "due" ? -1 : 0) ||
                    Number(b.engagements) - Number(a.engagements),
                )
                .map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link href={`/clients/${x.id}`}>{x.name}</Link>
                    </td>
                    <td>{human(x.type)}</td>
                    <td>{x.engagements}</td>
                    <td>{x.last?.slice(0, 7) ?? "Unknown"}</td>
                    <td>
                      <Badge
                        tone={
                          x.health === "due" || x.health === "at risk"
                            ? "warning"
                            : x.health === "active"
                              ? "success"
                              : "neutral"
                        }
                      >
                        {x.gap === null ? "Unknown" : human(x.health)}
                      </Badge>
                      <small>
                        {x.gap === null
                          ? "No observed month"
                          : `${x.gap} months since engagement`}
                      </small>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Pager>
      </Panel>
    </div>
  );
}
