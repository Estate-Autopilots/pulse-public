"use client";
// PR-PIPELINE: the pipeline's screens in PR Studio: proof of work (score, trend, work as it happens with proof links,
// milestones), ideas with their designed creatives and the approval flow, brands with the three-step setup wizard, and
// the weekly "what I did" report with its "Share with…" dialog. Nothing is posted or sent from here: people approve and
// post themselves, and a report is shared only when its person chooses who sees it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, Play, Plus, Share2, ShieldCheck, Sparkles, X } from "lucide-react";
import { post } from "../orgs/client";
import { dayName } from "../lib/pr-studio.mjs";
import { ANGLE_WORDS, APPROVAL_WORDS, FORMAT_WORDS, INDUSTRY_WORDS, KIND_WORDS, MOVE_WORDS, SOURCE_WORDS, STEPS, contrast, contrastWords, nextMoves, num, proofHref, stepReady, trend } from "../lib/pr-pipeline.mjs";
import type { Brand, BrandKind, Creative, DraftMeta, Idea, IdeaDraft, Overview, Proof, Report, ShareTarget, WizardData } from "./pipeline-types";
import css from "./pr.module.css";

const errorText = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
function useAct() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act<T>(path: string, body: unknown, then?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await post<T>(path, body); then?.(r); router.refresh(); return r; }
    catch (e) { setError(errorText(e)); return null; }
    finally { setBusy(false); }
  }
  return { busy, error, act, router };
}
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not load. Try again.");
  return data as T;
}

/** A designed image served by the API (PNG, rendered on the server). */
function Png({ src, alt, className }: { src: string; alt: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a private PNG from the API, sized by CSS; next/image would only proxy it
  return <img className={className} src={src} alt={alt} loading="lazy" />;
}

function ProofLinks({ proof }: { proof: Proof[] }) {
  if (!proof?.length) return <span className={css.error}>No proof yet: do not post a claim without it.</span>;
  return <ul className={css.proof}>{proof.map((p, i) => { const href = proofHref(p.url);
    return <li key={i}>{href ? <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{p.label}</a> : <span title={p.url}>{p.label} <code>{p.url}</code></span>}</li>; })}</ul>;
}

// ------------------------------------------------------------------------------------------------ proof of work
function ScoreCard({ title, score, currency }: { title: string; score: Overview["scores"][number] | undefined; currency: string }) {
  if (!score) return <article className={css.card}><h3 className={css.cardTitle}>{title}</h3><p className={css.muted}>No score yet. It is worked out once a day after the first run.</p></article>;
  const t = trend(score.score, score.scoreBefore);
  const Arrow = t.dir === "up" ? ArrowUpRight : t.dir === "down" ? ArrowDownRight : ArrowRight;
  return <article className={css.card} aria-label={`Proof of work: ${title}`}>
    <header className={css.cardHead}><h3 className={css.cardTitle}>{title}</h3><span className={css.trend} data-dir={t.dir}><Arrow size={14} aria-hidden="true" />{t.text}</span></header>
    <div className={css.score}><strong>{score.score}</strong><span className={css.muted}>of 100 · proof of work</span></div>
    <dl className={css.stats}>
      <div><dt>Work in 7 days</dt><dd>{num(score.events7d)}</dd></div>
      <div><dt>A day</dt><dd>{score.velocity}</dd></div>
      <div><dt>Shipped in 7 days</dt><dd>{num(score.shipped7d)}</dd></div>
      <div><dt>Days in a row</dt><dd>{num(score.streak)}</dd></div>
      <div><dt>Hours of work, 30 days (estimate)</dt><dd>{num(score.hours30d)}</dd></div>
      <div><dt>Value, 30 days (estimate)</dt><dd>{currency} {num(score.value30d, currency)}</dd></div>
    </dl>
  </article>;
}

export function PipelineView({ o }: { o: Overview }) {
  const { busy, error, act } = useAct();
  const [ran, setRan] = useState<Record<string, unknown> | null>(null);
  const company = o.scores.find((s) => !s.brandId && !s.personId);
  const people = o.scores.filter((s) => s.personId && !s.brandId);
  const s = o.settings;
  return <div className={css.stack}>
    {o.studio && !s?.enabled ? <p className={css.empty}>The pipeline is off. Set up a brand under <Link href="/pr?tab=brands">Brands</Link> to switch it on: it then gathers the work every 6 hours, groups it into milestones and turns what shipped into ideas, drafts and designed images for you to approve.</p> : null}
    <div className={css.grid}>
      <ScoreCard title="The company" score={company} currency={o.currency} />
      {o.brands.filter((b) => !b.archived).map((b) => <ScoreCard key={b.id} title={b.name} score={o.scores.find((x) => x.brandId === b.id && !x.personId)} currency={o.currency} />)}
    </div>
    {o.trend.length > 1 ? <section className={css.section} aria-label="Score over time">
      <div className={css.sectionHead}><h2>Score over the last weeks</h2></div>
      <div className={css.spark} role="img" aria-label={`Proof-of-work score from ${o.trend[0].score} to ${o.trend[o.trend.length - 1].score}`}>
        {o.trend.map((p) => <span key={p.day} style={{ height: `${Math.max(4, p.score)}%` }} title={`${dayName(p.day)}: ${p.score}`} />)}
      </div>
    </section> : null}
    {people.length ? <section className={css.section} aria-label="People">
      <div className={css.sectionHead}><h2>People</h2><span className={css.muted}>Work attributed to each person</span></div>
      <table className={css.table}><thead><tr><th>Person</th><th>Score</th><th>Trend</th><th>Work, 7 days</th><th>Days in a row</th><th>Hours, 30 days (estimate)</th></tr></thead>
        <tbody>{people.map((p) => <tr key={p.personId}><td>{p.person}</td><td>{p.score}</td><td>{trend(p.score, p.scoreBefore).text}</td><td>{num(p.events7d)}</td><td>{num(p.streak)}</td><td>{num(p.hours30d)}</td></tr>)}</tbody></table>
    </section> : null}
    {o.studio ? <section className={css.section} aria-label="Run the pipeline">
      <div className={css.sectionHead}><h2>Pipeline</h2>
        <div className={css.actions}>
          <span className={css.muted}>{s?.lastTickAt ? `Last run ${dayName(s.lastTickAt.slice(0, 10))} ${s.lastTickAt.slice(11, 16)} UTC` : "Not run yet"}</span>
          <button type="button" className={`${css.btn} ${css.primary}`} disabled={busy || !s?.enabled} onClick={() => act<{ run: Record<string, unknown> }>("pr/pipeline/run", {}, (r) => setRan(r.run))}><Play size={14} aria-hidden="true" />Run now</button>
        </div>
      </div>
      {ran ? <p className={css.muted} role="status">Gathered {String(ran.collected ?? 0)} new pieces of work, {String(ran.ideas ?? 0)} new ideas.</p> : null}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      {s ? <Settings o={o} /> : null}
    </section> : null}
    <section className={css.section} aria-label="Milestones">
      <div className={css.sectionHead}><h2>Milestones</h2><span className={css.muted}>Work grouped into what is worth telling</span></div>
      {o.milestones.length ? <ul className={css.lines}>{o.milestones.map((m) => <li key={m.id} className={css.entry}>
        <span className={css.kind} data-kind={m.shipped ? "release" : "task"}>{m.status === "ideated" ? "Ideas made" : m.status === "ready" ? "Ready" : m.status === "dismissed" ? "Set aside" : "Growing"}</span>
        <span className={css.entryText}><span className={css.lineTitle}>{m.title}</span>
          <span className={css.entryBody}>{m.brand} · {m.events === 1 ? "1 piece" : `${num(m.events)} pieces`} of work · {num(m.hours)} hours (estimate) · {dayName(m.startedOn)}{m.endedOn !== m.startedOn ? ` to ${dayName(m.endedOn)}` : ""}{m.clientNamed ? " · names a client" : ""}</span>
          <ProofLinks proof={m.proof.slice(0, 3)} /></span>
      </li>)}</ul> : <p className={css.empty}>No milestones yet. They appear as work is gathered.</p>}
    </section>
    <section className={css.section} aria-label="Work as it happens">
      <div className={css.sectionHead}><h2>Work as it happens</h2><span className={css.muted}>Every line links to its proof</span></div>
      {o.events.length ? <ul className={css.lines}>{o.events.map((e) => { const href = proofHref(e.proofUrl);
        return <li key={e.id} className={css.entry}>
          <span className={css.kind}>{SOURCE_WORDS[e.source as keyof typeof SOURCE_WORDS] ?? e.source}</span>
          <span className={css.entryText}><span className={css.lineTitle}>{href ? <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{e.title}</a> : e.title}</span>
            <span className={css.entryBody}>{[e.person, e.brand, e.repo, dayName(e.happenedAt.slice(0, 10))].filter(Boolean).join(" · ")}{href ? "" : ` · proof: ${e.proofUrl}`}</span></span>
        </li>; })}</ul> : <p className={css.empty}>Nothing gathered yet.</p>}
    </section>
  </div>;
}

function Settings({ o }: { o: Overview }) {
  const { busy, error, act } = useAct();
  const s = o.settings!;
  const lim = o.limits;
  return <form className={css.form} aria-label="Pipeline settings" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
    act("pr/pipeline/settings", { enabled: f.get("enabled") === "on", aiAssist: f.get("aiAssist") === "on", reportPersonId: String(f.get("reportPersonId") ?? ""),
      hourlyValue: Number(f.get("hourlyValue")), currency: String(f.get("currency") ?? "INR").toUpperCase() }); }}>
    <div className={css.row}>
      <label className={css.inline}><input type="checkbox" name="enabled" defaultChecked={s.enabled} />Pipeline on</label>
      <label className={css.inline}><input type="checkbox" name="aiAssist" defaultChecked={s.aiAssist} disabled={!lim?.aiPerMonth} />AI help: the PR team sharpens new ideas</label>
      <label className={css.field}>Weekly report for<select name="reportPersonId" defaultValue={s.reportPersonId ?? ""}><option value="">Nobody</option>{o.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className={css.field}>Value of an hour (for estimates)<span className={css.inline}><input name="currency" defaultValue={s.currency} maxLength={3} size={4} aria-label="Currency" /><input name="hourlyValue" type="number" min={1} max={100000} defaultValue={s.hourlyValue} aria-label="Hourly value" /></span></label>
    </div>
    {lim ? <p className={css.muted}>Plan {lim.tier}: {lim.used.brands} of {lim.brands} brands · {lim.used.creatives} of {lim.creativesPerMonth} creatives this month · {lim.used.ai} of {lim.aiPerMonth} AI tasks this month.{lim.used.creatives >= lim.creativesPerMonth || lim.used.brands >= lim.brands ? <> <Link href="/settings/billing">Upgrade the plan</Link> for more.</> : null}</p> : null}
    <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>Save settings</button>{error ? <span className={css.error} role="alert">{error}</span> : null}</div>
  </form>;
}

// ------------------------------------------------------------------------------------------------ ideas and approvals
function CheckList({ c }: { c: Creative }) {
  const entries = Object.entries(c.checks ?? {});
  if (c.status === "queued") return <span className={css.muted}>Being designed…</span>;
  if (c.status === "failed") return <span className={css.error}>Not made: {c.error || "try again later"}</span>;
  return <ul className={css.checks} aria-label="Automatic checks">{entries.map(([k, v]) => <li key={k} data-ok={v?.ok ? "yes" : "no"}>
    {v?.ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}{({ contrast: "Contrast", legible360: "Readable on a phone", cropSafe: "Safe from cropping", spelling: "Spelling", privacy: "No private data" } as Record<string, string>)[k] ?? k}
    {v?.detail ? <span className={css.muted}> · {v.detail}</span> : null}</li>)}</ul>;
}

function Approvals({ d }: { d: IdeaDraft }) {
  const { busy, error, act } = useAct();
  const move = (to: string) => {
    if (to === "client_ok") { const how = window.prompt("How did the client give their OK? (for example: by e-mail on 6 Nov)"); if (!how) return; return act(`pr/pipeline/drafts/${d.id}/move`, { to, note: how }); }
    if (to === "posted") { const url = window.prompt("Link to the post (optional, starts with https://)") ?? ""; return act(`pr/pipeline/drafts/${d.id}/move`, { to, url: url.trim() || undefined }); }
    return act(`pr/pipeline/drafts/${d.id}/move`, { to });
  };
  return <div className={css.actions}>
    <span className={css.chip} data-approval={d.approval}>{APPROVAL_WORDS[d.approval]}</span>
    {d.needsClientOk ? <span className={d.clientOkAt ? css.badge : css.warn}><ShieldCheck size={12} aria-hidden="true" />{d.clientOkAt ? `Client OK: ${d.clientOkNote || "given"}` : `Needs the client's OK${d.clientNamed ? ` (${d.clientNamed})` : ""}`}</span> : null}
    {nextMoves(d).map((to) => <button key={to} type="button" className={`${css.btn} ${to === "approved" || to === "posted" ? css.primary : ""}`} disabled={busy} onClick={() => move(to)}>{MOVE_WORDS[to as keyof typeof MOVE_WORDS]}</button>)}
    {d.planOn ? <span className={css.muted}>On the calendar for {dayName(d.planOn)}</span> : null}
    {d.postedUrl ? <a className={css.link} href={d.postedUrl} target="_blank" rel="noreferrer">The post</a> : null}
    {error ? <span className={css.error} role="alert">{error}</span> : null}
  </div>;
}

function Performance({ d }: { d: IdeaDraft }) {
  const { busy, error, act } = useAct();
  if (d.approval !== "posted") return null;
  return <div className={css.stack}>
    <h4 className={css.sub}>How it did</h4>
    {d.metrics.length ? <table className={css.table}><thead><tr><th>Day</th><th>Seen</th><th>Reactions</th><th>Comments</th><th>Shares</th><th>Clicks</th></tr></thead>
      <tbody>{d.metrics.map((m, i) => <tr key={i}><td>{dayName(m.recordedOn)}</td><td>{m.impressions ?? "–"}</td><td>{m.reactions ?? "–"}</td><td>{m.comments ?? "–"}</td><td>{m.shares ?? "–"}</td><td>{m.clicks ?? "–"}</td></tr>)}</tbody></table> : null}
    <form className={css.actions} aria-label="Log how the post did" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form);
      const n = (k: string) => String(f.get(k) ?? "") === "" ? null : Number(f.get(k));
      act(`pr/pipeline/drafts/${d.id}/metrics`, { impressions: n("impressions"), reactions: n("reactions"), comments: n("comments"), shares: n("shares"), clicks: n("clicks") }, () => form.reset()); }}>
      {(["impressions", "reactions", "comments", "shares", "clicks"] as const).map((k) => <label key={k} className={css.inline}>{({ impressions: "Seen", reactions: "Reactions", comments: "Comments", shares: "Shares", clicks: "Clicks" })[k]}
        <input name={k} type="number" min={0} inputMode="numeric" size={6} /></label>)}
      <button type="submit" className={css.btn} disabled={busy}><Plus size={14} aria-hidden="true" />Log</button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </form>
    <p className={css.note}>Entered by hand for now; reading the numbers from the channels comes later.</p>
  </div>;
}

export function IdeaCard({ idea }: { idea: Idea }) {
  const [open, setOpen] = useState(false);
  const d = idea.draft;
  return <article className={css.card} id={`idea-${idea.id}`} data-status={d?.approval === "posted" ? "posted" : undefined}>
    <header className={css.cardHead}>
      <span className={css.chip}>{idea.brand} · {FORMAT_WORDS[idea.format as keyof typeof FORMAT_WORDS] ?? "Post"} · {ANGLE_WORDS[idea.angle as keyof typeof ANGLE_WORDS] ?? "Angle"}</span>
      <span className={css.muted}>{dayName(idea.day)}{idea.writtenBy === "ai" ? " · sharpened by the PR team" : ""}</span>
    </header>
    <h3 className={css.cardTitle}>{idea.hook || idea.title}</h3>
    <ProofLinks proof={idea.proof} />
    {idea.creatives.length ? <div className={css.images}>{idea.creatives.map((c) => <figure key={c.id} className={css.image}>
      {c.hasImage ? <Png src={`/api/v0/pr/pipeline/creatives/${c.id}.png`} alt={`${idea.brand}: ${c.template}${c.slides > 1 ? ` slide ${c.slide} of ${c.slides}` : ""}`} /> : <div className={css.placeholder}>{c.status === "failed" ? "Not made" : "Being designed…"}</div>}
      <figcaption><span className={css.muted}>{c.slides > 1 ? `${c.slide} / ${c.slides}` : c.template}</span>{c.hasImage ? <a className={css.link} href={`/api/v0/pr/pipeline/creatives/${c.id}.png`} download>Download</a> : null}<CheckList c={c} /></figcaption>
    </figure>)}</div> : null}
    {d ? <>
      <button type="button" className={css.link} onClick={() => setOpen(!open)}>{open ? "Hide the words" : "The words"}</button>
      {open ? <div className={css.stack}><pre className={css.copy} data-open="yes">{d.copy}</pre><pre className={css.copy} data-open="yes">{d.longPost}</pre>
        <Link className={css.link} href={`/pr?tab=drafts&draft=${d.id}`}>Edit the words in Drafts</Link></div> : null}
      <Approvals d={d} />
      <Performance d={d} />
    </> : null}
  </article>;
}

export function IdeasView({ ideas, brands, brand }: { ideas: Idea[]; brands: Brand[]; brand: string | null }) {
  return <div className={css.stack}>
    <div className={css.actions}>
      <span className={css.muted}>Brand:</span>
      <Link className={css.btn} aria-current={!brand ? "page" : undefined} href="/pr?tab=ideas">All</Link>
      {brands.filter((b) => !b.archived).map((b) => <Link key={b.id} className={css.btn} aria-current={brand === b.id ? "page" : undefined} href={`/pr?tab=ideas&brand=${b.id}`}>{b.name}{b.inReview ? ` · ${b.inReview} in review` : ""}</Link>)}
    </div>
    <p className={css.muted}>Ideas come from milestones that shipped. Each has a hook, an angle, its proof and a format, a draft on the brand&apos;s calendar and designed images that passed automatic checks. Approve, then post it yourself.</p>
    {ideas.length ? <div className={css.grid}>{ideas.map((i) => <IdeaCard key={i.id} idea={i} />)}</div> : <p className={css.empty}>No ideas yet. They are made after each run, from work that shipped.</p>}
  </div>;
}

// ------------------------------------------------------------------------------------------------ brands and the wizard
type Form = { name: string; kind: BrandKind; industry: string; byline: string; clientId: string; ownerPersonId: string; bg: string; fg: string; accent: string; useCompanyMark: boolean;
  audiences: { name: string; tone: string; channel: string; ratio: string }[]; goals: string[]; postsPerWeek: number; projects: string[]; repos: string; reportFolders: string; approvers: string[] };
const START: Form = { name: "", kind: "company", industry: "other", byline: "", clientId: "", ownerPersonId: "", bg: "#0E2A2F", fg: "#EEF2F1", accent: "#FF8D8A", useCompanyMark: true,
  audiences: [], goals: [], postsPerWeek: 3, projects: [], repos: "", reportFolders: "", approvers: [] };

export function BrandWizard({ me }: { me: string | null }) {
  const { busy, error, act } = useAct();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>({ ...START, ownerPersonId: me ?? "" });
  const [data, setData] = useState<WizardData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { let live = true;
    getJson<WizardData>(`pr/pipeline/setup?industry=${f.industry}`).then((d) => { if (!live) return; setData(d);
      setF((x) => ({ ...x, audiences: d.template.audiences.map((a) => ({ ...a })), goals: [...d.template.goals], postsPerWeek: d.template.postsPerWeek })); }).catch((e) => live && setLoadError(errorText(e)));
    return () => { live = false; }; }, [f.industry]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const ratio = contrast(f.bg, f.fg);
  const words = contrastWords(ratio);
  const full = data ? data.limits.used.brands >= data.limits.brands : false;
  if (done) return <p className={css.empty} role="status">The brand is set up and the pipeline is on. <Link href="/pr?tab=pipeline">See the pipeline</Link> or run it now.</p>;
  if (loadError) return <p className={css.error} role="alert">{loadError}</p>;
  return <form className={css.form} aria-label="Set up a brand" onSubmit={(e) => { e.preventDefault();
    if (step < 2) { setStep(step + 1); return; }
    act<{ brand: Brand }>("pr/pipeline/brands", { name: f.name, kind: f.kind, industry: f.industry, byline: f.byline, clientId: f.kind === "client" ? f.clientId : undefined,
      ownerPersonId: f.kind === "personal" ? f.ownerPersonId : undefined, kit: { bg: f.bg, fg: f.fg, accent: f.accent, useCompanyMark: f.useCompanyMark },
      audiences: f.audiences.filter((a) => a.name.trim()), goals: f.goals.filter((g) => g.trim()), postsPerWeek: f.postsPerWeek, approvers: f.approvers,
      sources: { projects: f.projects, repos: f.repos.split("\n").map((x) => x.trim()).filter(Boolean), reportFolders: f.reportFolders.split("\n").map((x) => x.trim()).filter(Boolean) } },
    (r) => setDone(r.brand.id)); }}>
    <ol className={css.steps} aria-label="Steps">{STEPS.map((s, i) => <li key={s} aria-current={i === step ? "step" : undefined} data-done={i < step ? "yes" : undefined}>{i + 1}. {s}</li>)}</ol>
    {full ? <p className={css.warn}>Your plan includes {data!.limits.brands} brand{data!.limits.brands === 1 ? "" : "s"}. <Link href="/settings/billing">Upgrade the plan</Link> to add another.</p> : null}
    {step === 0 ? <div className={css.stack}>
      <div className={css.row}>
        <label className={css.field}>Brand name<input value={f.name} maxLength={80} required onChange={(e) => set("name", e.target.value)} placeholder="For example: Example Studio" /></label>
        <label className={css.field}>Whose brand<select value={f.kind} onChange={(e) => set("kind", e.target.value as BrandKind)}>{Object.entries(KIND_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className={css.field}>Industry<select value={f.industry} onChange={(e) => set("industry", e.target.value)}>{Object.entries(INDUSTRY_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      {f.kind === "client" ? <label className={css.field}>The client<select value={f.clientId} required onChange={(e) => set("clientId", e.target.value)}><option value="">Choose a client</option>{data?.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label> : null}
      {f.kind === "personal" ? <label className={css.field}>Whose personal brand<select value={f.ownerPersonId} onChange={(e) => set("ownerPersonId", e.target.value)}>{data?.people.filter((p) => p.side === "staff").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
      <label className={css.field}>A line under the name (optional)<input value={f.byline} maxLength={120} onChange={(e) => set("byline", e.target.value)} /></label>
      <div className={css.row}>
        {(["bg", "fg", "accent"] as const).map((k) => <label key={k} className={css.field}>{({ bg: "Background", fg: "Text", accent: "Accent" })[k]}
          <span className={css.inline}><input type="color" value={f[k]} onChange={(e) => set(k, e.target.value.toUpperCase())} aria-label={`${k} colour`} /><input value={f[k]} maxLength={7} onChange={(e) => set(k, e.target.value)} /></span></label>)}
        <div className={css.kitPreview} style={{ background: f.bg, color: f.fg }} aria-label="Preview"><strong>{f.name || "Your brand"}</strong><span style={{ color: f.accent }}>Accent</span></div>
      </div>
      <p className={words.ok ? css.badge : css.warn} role="status">Text on background: {words.text}</p>
      <label className={css.inline}><input type="checkbox" checked={f.useCompanyMark} onChange={(e) => set("useCompanyMark", e.target.checked)} />Use the company&apos;s logo from Settings → Organisation on the images</label>
    </div> : null}
    {step === 1 ? <div className={css.stack}>
      <p className={css.muted}>Who the posts are for. Started from the {INDUSTRY_WORDS[f.industry as keyof typeof INDUSTRY_WORDS] ?? "usual"} template; change anything.</p>
      {f.audiences.map((a, i) => <div key={i} className={css.row}>
        <label className={css.field}>Audience<input value={a.name} maxLength={60} onChange={(e) => set("audiences", f.audiences.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></label>
        <label className={css.field}>Channel<select value={a.channel} onChange={(e) => set("audiences", f.audiences.map((x, j) => j === i ? { ...x, channel: e.target.value } : x))}>
          {["linkedin", "x", "whatsapp", "telegram", "email"].map((c) => <option key={c} value={c}>{({ linkedin: "LinkedIn", x: "X", whatsapp: "WhatsApp", telegram: "Telegram", email: "E-mail" } as Record<string, string>)[c]}</option>)}</select></label>
        <label className={css.field}>Tone<select value={a.tone} onChange={(e) => set("audiences", f.audiences.map((x, j) => j === i ? { ...x, tone: e.target.value } : x))}>{["warm", "formal", "bold", "plain"].map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select></label>
        <button type="button" className={css.icon} aria-label="Remove this audience" onClick={() => set("audiences", f.audiences.filter((_, j) => j !== i))}><X size={14} aria-hidden="true" /></button>
      </div>)}
      {f.audiences.length < 6 ? <button type="button" className={css.btn} onClick={() => set("audiences", [...f.audiences, { name: "", tone: "warm", channel: "linkedin", ratio: "4:5" }])}><Plus size={14} aria-hidden="true" />Add an audience</button> : null}
      <label className={css.field}>Goals, one a line<textarea rows={4} value={f.goals.join("\n")} onChange={(e) => set("goals", e.target.value.split("\n").slice(0, 12))} /></label>
    </div> : null}
    {step === 2 ? <div className={css.stack}>
      <label className={css.field}>Posts a week<input type="number" min={1} max={7} value={f.postsPerWeek} onChange={(e) => set("postsPerWeek", Number(e.target.value))} /></label>
      <p className={css.muted}>Work comes from this company&apos;s own records (tasks done, deliveries, goals, releases, bugs fixed, client approvals). Add more sources below.</p>
      {data?.projects.length ? <label className={css.field}>{f.kind === "client" ? "The client's projects" : "Projects that count for this brand (optional)"}
        <select multiple size={6} value={f.projects} onChange={(e) => set("projects", Array.from(e.target.selectedOptions, (o) => o.value))}>{data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
      <label className={css.field}>Code repositories on your server, one a line (optional; read only)<textarea rows={2} value={f.repos} placeholder="/srv/example/repo" onChange={(e) => set("repos", e.target.value)} /></label>
      <label className={css.field}>Report folders, one a line (optional)<textarea rows={2} value={f.reportFolders} onChange={(e) => set("reportFolders", e.target.value)} /></label>
      {f.kind === "client" ? <label className={css.field}>Who approves for the client (people with client access or colleagues)
        <select multiple size={5} value={f.approvers} onChange={(e) => set("approvers", Array.from(e.target.selectedOptions, (o) => o.value))}>{data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.side === "client" ? " (client)" : ""}</option>)}</select></label> : null}
    </div> : null}
    <div className={css.actions}>
      {step > 0 ? <button type="button" className={css.btn} onClick={() => setStep(step - 1)}><ChevronLeft size={14} aria-hidden="true" />Back</button> : null}
      <button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy || full || !stepReady(step, f)}>{step < 2 ? <>Next<ChevronRight size={14} aria-hidden="true" /></> : <><Sparkles size={14} aria-hidden="true" />Set up the brand</>}</button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </div>
  </form>;
}

export function BrandsView({ o }: { o: Overview }) {
  const [adding, setAdding] = useState(!o.brands.length);
  const { busy, error, act } = useAct();
  return <div className={css.stack}>
    {o.brands.map((b) => <details key={b.id} className={css.card} data-archived={b.archived ? "yes" : undefined}>
      <summary className={css.cardHead}><strong>{b.name}</strong><span className={css.muted}>{KIND_WORDS[b.kind]} · {INDUSTRY_WORDS[b.industry as keyof typeof INDUSTRY_WORDS] ?? b.industry} · {b.postsPerWeek} posts a week{b.archived ? " · archived" : ""}</span></summary>
      <div className={css.kitPreview} style={{ background: b.kit.bg ?? "#0E2A2F", color: b.kit.fg ?? "#EEF2F1" }}><strong>{b.name}</strong><span style={{ color: b.kit.accent ?? "#FF8D8A" }}>{b.byline || "Accent"}</span></div>
      {b.goals.length ? <ul className={css.proof}>{b.goals.map((g) => <li key={g}>{g}</li>)}</ul> : null}
      {b.role === "manager" ? <div className={css.actions}>
        <label className={css.inline}>Posts a week<input type="number" min={1} max={7} defaultValue={b.postsPerWeek} onBlur={(e) => Number(e.target.value) !== b.postsPerWeek && act(`pr/pipeline/brands/${b.id}`, { postsPerWeek: Number(e.target.value) })} /></label>
        {b.kind === "personal" && b.ownerPersonId === o.me ? <button type="button" className={css.btn} disabled={busy} onClick={() => act(`pr/pipeline/brands/${b.id}/career`, {})}>Add my career highlights</button> : null}
        <button type="button" className={css.btn} disabled={busy} onClick={() => act(`pr/pipeline/brands/${b.id}`, { archived: !b.archived })}>{b.archived ? "Bring back" : "Archive"}</button>
      </div> : null}
    </details>)}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {o.studio ? adding ? <BrandWizard me={o.me} /> : <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Set up a brand</button> : null}
    {o.limits ? <p className={css.muted}>Your plan ({o.limits.tier}) includes {o.limits.brands} brand{o.limits.brands === 1 ? "" : "s"}; {o.limits.used.brands} in use.</p> : null}
  </div>;
}

// ------------------------------------------------------------------------------------------------ the weekly report
function ShareDialog({ report, onClose }: { report: Report; onClose: () => void }) {
  const { busy, error, act } = useAct();
  const [targets, setTargets] = useState<ShareTarget[] | null>(null);
  const [org, setOrg] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { getJson<{ targets: ShareTarget[] }>("pr/pipeline/reports/share-targets").then((r) => { setTargets(r.targets); setOrg(r.targets[0]?.orgId ?? ""); }).catch((e) => setLoadError(errorText(e))); }, []);
  const t = targets?.find((x) => x.orgId === org);
  return <div className={css.dialog} role="dialog" aria-modal="true" aria-label="Share with…">
    <div className={css.form}>
      <h3 className={css.sub}>Share “{report.title}” with…</h3>
      <p className={css.muted}>They get it in PR Studio in that company, as a brief written for them. Nothing is sent by e-mail or chat.</p>
      {loadError ? <p className={css.error}>{loadError}</p> : !targets ? <p className={css.muted}>Loading…</p> : !targets.length ? <p className={css.empty}>You lead in no other company on Pulse, so there is nobody to share it with.</p> : <>
        <label className={css.field}>Company<select value={org} onChange={(e) => { setOrg(e.target.value); setPeople([]); }}>{targets.map((x) => <option key={x.orgId} value={x.orgId}>{x.org}</option>)}</select></label>
        <fieldset className={css.stack}><legend className={css.muted}>People</legend>{t?.people.map((p) => <label key={p.id} className={css.pick}>
          <input type="checkbox" checked={people.includes(p.id)} onChange={() => setPeople((x) => x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id])} />{p.name}</label>)}</fieldset>
      </>}
      {done ? <p className={css.badge} role="status">{done}</p> : null}
      <div className={css.actions}>
        <button type="button" className={`${css.btn} ${css.primary}`} disabled={busy || !people.length || !!done}
          onClick={() => act<{ share: { shared: number; org: string } }>(`pr/pipeline/reports/${report.id}/share`, { orgId: org, people }, (r) => setDone(`Shared with ${r.share.shared} in ${r.share.org}.`))}><Share2 size={14} aria-hidden="true" />Share</button>
        <button type="button" className={css.btn} onClick={onClose}>Close</button>
        {error ? <span className={css.error} role="alert">{error}</span> : null}
      </div>
    </div>
  </div>;
}

function ReportCard({ r, currency }: { r: Report; currency: string }) {
  const { busy, error, act } = useAct();
  const [edit, setEdit] = useState(false);
  const [share, setShare] = useState(false);
  const n = r.numbers ?? {};
  return <article className={css.card} aria-label={r.title}>
    <header className={css.cardHead}><h3 className={css.cardTitle}>{r.title}</h3><span className={r.status === "shared" ? css.badge : css.chip}>{r.status === "shared" ? "Shared" : "Draft, only you see it"}</span></header>
    <dl className={css.stats}>
      <div><dt>Shipped</dt><dd>{num(Number(n.shipped ?? 0))}</dd></div>
      <div><dt>Pieces of work</dt><dd>{num(Number(n.events ?? 0))}</dd></div>
      <div><dt>Hours (estimate)</dt><dd>{num(Number(n.hours ?? 0))}</dd></div>
      <div><dt>Value (estimate)</dt><dd>{String(n.currency ?? currency)} {num(Number(n.value ?? 0), String(n.currency ?? currency))}</dd></div>
      {n.score !== null && n.score !== undefined ? <div><dt>Proof-of-work score</dt><dd>{String(n.score)}</dd></div> : null}
    </dl>
    {r.cardId ? <Png className={css.reportCard} src={`/api/v0/pr/pipeline/creatives/${r.cardId}.png`} alt={`One-page summary: ${r.title}`} /> : <p className={css.muted}>The one-page summary card is being designed.</p>}
    {edit ? <form className={css.stack} onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
      act(`pr/pipeline/reports/${r.id}`, { title: String(f.get("title") ?? ""), body: String(f.get("body") ?? ""), next: String(f.get("next") ?? "") }, () => setEdit(false)); }}>
      <label className={css.field}>Title<input name="title" defaultValue={r.title} maxLength={160} required /></label>
      <label className={css.field}>What shipped and its impact<textarea name="body" rows={12} defaultValue={r.body} maxLength={12000} required /></label>
      <label className={css.field}>What is next<textarea name="next" rows={4} defaultValue={r.next} maxLength={4000} /></label>
      <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>Save</button><button type="button" className={css.btn} onClick={() => setEdit(false)}>Cancel</button></div>
    </form> : <>
      <pre className={css.copy} data-open="yes">{r.body}</pre>
      {r.next ? <><h4 className={css.sub}>What is next</h4><pre className={css.copy} data-open="yes">{r.next}</pre></> : null}
      <h4 className={css.sub}>Proof</h4><ProofLinks proof={r.proof} />
    </>}
    {r.shared.length ? <p className={css.muted}>Shared: {r.shared.map((s) => `${s.org} (${s.people.length}) on ${dayName(String(s.at).slice(0, 10))}`).join("; ")}</p> : null}
    {r.mine ? <footer className={css.actions}>
      <button type="button" className={css.btn} onClick={() => setEdit(true)}>Edit</button>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setShare(true)}><Share2 size={14} aria-hidden="true" />Share with…</button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </footer> : null}
    {share ? <ShareDialog report={r} onClose={() => setShare(false)} /> : null}
  </article>;
}

export function ReportsView({ reports, currency }: { reports: Report[]; currency: string }) {
  return <div className={css.stack}>
    <p className={css.muted}>Every Monday at 09:00 the weekly report of the person chosen in the pipeline&apos;s settings is written here as a draft: what shipped, the impact, proof links, what is next and a one-page card. Nobody else gets it until that person shares it.</p>
    {reports.length ? reports.map((r) => <ReportCard key={r.id} r={r} currency={currency} />) : <p className={css.empty}>No weekly report yet.</p>}
  </div>;
}

/** For the calendar: a filter by brand and the approval state on each pipeline post. */
export function BrandFilter({ brands, brand, month }: { brands: Brand[]; brand: string | null; month: string }) {
  if (!brands.length) return null;
  return <div className={css.actions} aria-label="Brand">
    <span className={css.muted}>Brand:</span>
    <Link className={css.btn} aria-current={!brand ? "page" : undefined} href={`/pr?tab=calendar&month=${month}`}>All</Link>
    {brands.filter((b) => !b.archived).map((b) => <Link key={b.id} className={css.btn} aria-current={brand === b.id ? "page" : undefined} href={`/pr?tab=calendar&month=${month}&brand=${b.id}`}>{b.name}</Link>)}
  </div>;
}
export type { DraftMeta };
