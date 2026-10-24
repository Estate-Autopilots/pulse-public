"use client";
// FEATURES-1024 (owner, 23 Oct 2026): Product Story. A product's versions from the first idea to now on a timeline (what
// changed, screenshots, videos and tutorials, how the tests went, the release it is) and a comparison of any two
// versions with everything that changed between them. Everyone adds and edits; leaders remove.
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { BookOpen, CircleAlert, ExternalLink, FileText, Film, GitCompareArrows, Image as ImageIcon, MonitorPlay, Plus, Presentation, Trash2, X } from "lucide-react";
import { useDialog, useSoonRefresh } from "../hq/client";
import hq from "../hq/hq.module.css";
import { KINDS, MEDIA, STAGES, chronological, countKinds, day, daysBetween, kindOf, stageOf, type Change, type ChangeKind, type Media, type MediaKind, type Product, type Stage, type StoryData, type Version } from "./model";
import css from "./story.module.css";

export async function storyPost<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/story/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "That did not save. Try again.");
  return d as T;
}
const MEDIA_ICON: Record<MediaKind, typeof ImageIcon> = { screenshot: ImageIcon, video: Film, tutorial: MonitorPlay, doc: FileText, demo: Presentation };
const tone = (t: string) => ({ "--tone": t }) as CSSProperties;

export function StoryWorkbench({ data, initialProduct, initialVersion }: { data: StoryData; initialProduct: string | null; initialVersion: string | null }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  const soon = useSoonRefresh(refresh);
  const [productId, setProductId] = useState<string | null>(initialProduct);
  const [view, setView] = useState<"timeline" | "compare">("timeline");
  const [open, setOpen] = useState<string | "new" | null>(initialVersion);
  const [editProduct, setEditProduct] = useState<Product | "new" | null>(null);
  const [pair, setPair] = useState<string[]>([]);
  const product = data.products.find((p) => p.id === productId) ?? data.products[0] ?? null;
  const versions = useMemo(() => chronological(data.versions.filter((v) => v.productId === product?.id)), [data.versions, product]);
  const newestFirst = useMemo(() => [...versions].reverse(), [versions]);
  const togglePair = (id: string) => setPair((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]);

  if (!product) return <>
    <Head onNewProduct={() => setEditProduct("new")} />
    <section className={css.empty}><BookOpen size={28} aria-hidden="true" /><h2>Keep your product’s story</h2>
      <p>Every version from the first idea to now: what changed, how it looked, the videos and tutorials, how the tests went. Compare any two versions side by side.</p>
      <button type="button" className={hq.primary} onClick={() => setEditProduct("new")}><Plus size={16} aria-hidden="true" />Start a product’s story</button></section>
    <ProductSheet product={editProduct} canRemove={data.canRemove} onClose={() => setEditProduct(null)} onSaved={(id) => { if (id) setProductId(id); soon(); }} />
  </>;

  const first = versions[0], last = versions.at(-1);
  const allChanges = versions.flatMap((v) => v.changes);
  const mediaCount = versions.reduce((n, v) => n + v.media.length, 0);
  return <>
    <Head onNewProduct={() => setEditProduct("new")} onNewVersion={() => setOpen("new")} />
    {data.products.length > 1 ? <nav className={css.products} aria-label="Products">{data.products.map((p) => <button key={p.id} type="button" aria-pressed={p.id === product.id} onClick={() => { setProductId(p.id); setPair([]); }}>{p.name}</button>)}</nav> : null}
    <section className={css.productHead}>
      <div><h2>{product.name}</h2>{product.blurb ? <p>{product.blurb}</p> : null}</div>
      <span className={hq.headActions}>{product.repoUrl ? <a className={hq.secondary} href={product.repoUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden="true" />Code</a> : null}
        <button type="button" className={hq.secondary} onClick={() => setEditProduct(product)}>Edit product</button></span>
    </section>
    <section className={hq.kpis} aria-label="At a glance">
      <div className={hq.kpi}><span className={hq.kpiLabel}>Versions</span><span className={hq.kpiValue}>{versions.length}</span><span className={hq.kpiSub}>{first ? `since ${day(first.releasedOn)}` : "none yet"}</span></div>
      <div className={hq.kpi}><span className={hq.kpiLabel}>Latest</span><span className={hq.kpiValue}>{last?.label ?? "—"}</span><span className={hq.kpiSub}>{last ? `${stageOf(last.stage).label} · ${day(last.releasedOn)}` : "Add the first version"}</span></div>
      <div className={hq.kpi}><span className={hq.kpiLabel}>Changes recorded</span><span className={hq.kpiValue}>{allChanges.length}</span><span className={hq.kpiSub}>{countKinds(allChanges).map((k) => `${k.n} ${k.label.toLowerCase()}`).join(" · ") || "—"}</span></div>
      <div className={hq.kpi}><span className={hq.kpiLabel}>Screens, videos, tutorials</span><span className={hq.kpiValue}>{mediaCount}</span><span className={hq.kpiSub}>linked to versions</span></div>
    </section>
    <div className={css.bar}>
      <div className={css.views} role="tablist" aria-label="Views">
        <button type="button" role="tab" aria-selected={view === "timeline"} onClick={() => setView("timeline")}><BookOpen size={15} aria-hidden="true" />Timeline</button>
        <button type="button" role="tab" aria-selected={view === "compare"} onClick={() => setView("compare")}><GitCompareArrows size={15} aria-hidden="true" />Compare</button>
      </div>
      {view === "timeline" ? <span className={hq.faint}>{pair.length === 2 ? <button type="button" className={css.linkBtn} onClick={() => setView("compare")}>Compare the two chosen</button> : "Tick two versions to compare them"}</span> : null}
    </div>
    {view === "timeline"
      ? <Timeline versions={newestFirst} pair={pair} onPair={togglePair} onOpen={setOpen} onNew={() => setOpen("new")} />
      : <Compare versions={versions} pair={pair} setPair={setPair} onOpen={setOpen} />}
    <VersionSheet open={open} version={typeof open === "string" && open !== "new" ? data.versions.find((v) => v.id === open) ?? null : null} product={product} canRemove={data.canRemove}
      onClose={() => setOpen(null)} onSaved={soon} />
    <ProductSheet product={editProduct} canRemove={data.canRemove} onClose={() => setEditProduct(null)} onSaved={(id) => { if (id) setProductId(id); soon(); }} />
  </>;
}

function Head({ onNewProduct, onNewVersion }: { onNewProduct: () => void; onNewVersion?: () => void }) {
  return <header className={hq.pageHead}>
    <div><h1>Product Story</h1><p>From the first idea to now: every version with what changed, its screens, videos and tutorials, and how its tests went. Compare any two.</p></div>
    <div className={hq.headActions}>
      <button type="button" className={hq.secondary} onClick={onNewProduct}><Plus size={15} aria-hidden="true" />Product</button>
      {onNewVersion ? <button type="button" className={hq.primary} onClick={onNewVersion}><Plus size={15} aria-hidden="true" />New version</button> : null}
    </div>
  </header>;
}

function Chips({ changes }: { changes: Change[] }) {
  return <span className={css.chips}>{countKinds(changes).map((k) => <i key={k.key} style={tone(k.tone)}>{k.n} {k.label.toLowerCase()}</i>)}</span>;
}
function MediaLinks({ media }: { media: Media[] }) {
  if (!media.length) return null;
  return <span className={css.media}>{media.map((m, i) => { const Icon = MEDIA_ICON[m.kind] ?? FileText;
    return <a key={i} href={m.url} target="_blank" rel="noreferrer" title={m.url} onClick={(e) => e.stopPropagation()}><Icon size={14} aria-hidden="true" />{m.label || MEDIA.find((x) => x.key === m.kind)?.label}</a>; })}</span>;
}
function TestLine({ tests }: { tests: Version["tests"] }) {
  if (tests.passed == null && tests.failed == null && !tests.note) return null;
  const bad = (tests.failed ?? 0) > 0;
  return <span className={css.tests} data-bad={bad || undefined}>{tests.passed != null ? `${tests.passed} passed` : ""}{tests.failed != null ? `${tests.passed != null ? " · " : ""}${tests.failed} failed` : ""}
    {tests.note ? `${tests.passed != null || tests.failed != null ? " · " : ""}${tests.note}` : ""}{tests.url ? <a href={tests.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}> run</a> : null}</span>;
}

function Timeline({ versions, pair, onPair, onOpen, onNew }: { versions: Version[]; pair: string[]; onPair: (id: string) => void; onOpen: (id: string) => void; onNew: () => void }) {
  if (!versions.length) return <section className={css.empty}><p>No versions yet. Start with the idea: what it was for and who it was for.</p>
    <button type="button" className={hq.primary} onClick={onNew}><Plus size={16} aria-hidden="true" />Add the first version</button></section>;
  return <ol className={css.timeline}>{versions.map((v) => { const s = stageOf(v.stage);
    return <li key={v.id} style={tone(s.tone)}>
      <span className={css.dot} aria-hidden="true" />
      <article className={css.card} aria-label={`${v.label}${v.title ? `: ${v.title}` : ""}`}>
        <button type="button" className={css.cardMain} onClick={() => onOpen(v.id)}>
          <span className={css.cardTop}><b className={css.label}>{v.label}</b><span className={css.title}>{v.title}</span></span>
          <span className={css.meta}><time dateTime={v.releasedOn ?? undefined}>{day(v.releasedOn)}</time><i className={css.stage}>{s.label}</i>{v.releaseRef ? <code>{v.releaseRef}</code> : null}</span>
          {v.summary ? <span className={css.summary}>{v.summary}</span> : null}
          {v.changes.length ? <ul className={css.changes}>{v.changes.slice(0, 4).map((c, i) => <li key={i} style={tone(kindOf(c.kind).tone)}><i>{kindOf(c.kind).label}</i>{c.text}</li>)}
            {v.changes.length > 4 ? <li className={css.more}>+ {v.changes.length - 4} more</li> : null}</ul> : null}
        </button>
        <footer className={css.cardFoot}><Chips changes={v.changes} /><MediaLinks media={v.media} /><TestLine tests={v.tests} />
          <label className={css.pick}><input type="checkbox" checked={pair.includes(v.id)} onChange={() => onPair(v.id)} />Compare</label></footer>
      </article>
    </li>; })}</ol>;
}

function Compare({ versions, pair, setPair, onOpen }: { versions: Version[]; pair: string[]; setPair: (p: string[]) => void; onOpen: (id: string) => void }) {
  if (versions.length < 2) return <section className={css.empty}><p>Two versions are needed to compare. Add another version first.</p></section>;
  const ids = pair.length === 2 ? pair : [versions[0].id, versions.at(-1)!.id];
  const ordered = chronological(versions.filter((v) => ids.includes(v.id)));
  const [a, b] = ordered.length === 2 ? ordered : [versions[0], versions.at(-1)!];
  const ia = versions.indexOf(a), ib = versions.indexOf(b);
  const between = versions.slice(ia + 1, ib + 1);
  const gap = daysBetween(a.releasedOn, b.releasedOn);
  const pickAt = (side: 0 | 1, id: string) => { const next = [a.id, b.id]; next[side] = id; setPair(next); };
  return <section className={css.compare} aria-label="Compare two versions">
    <div className={css.compareBar}>
      <label>From <select value={a.id} onChange={(e) => pickAt(0, e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>{v.label}{v.title ? ` · ${v.title}` : ""}</option>)}</select></label>
      <label>to <select value={b.id} onChange={(e) => pickAt(1, e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>{v.label}{v.title ? ` · ${v.title}` : ""}</option>)}</select></label>
      <span className={hq.faint}>{gap !== null ? `${gap} ${gap === 1 ? "day" : "days"} apart · ` : ""}{between.length} {between.length === 1 ? "version" : "versions"} later · {between.reduce((n, v) => n + v.changes.length, 0)} changes</span>
    </div>
    <div className={css.sides}>{[a, b].map((v) => <article key={v.id} className={css.side} style={tone(stageOf(v.stage).tone)}>
      <button type="button" className={css.sideHead} onClick={() => onOpen(v.id)}><b className={css.label}>{v.label}</b><span>{v.title}</span>
        <small>{day(v.releasedOn)} · <i className={css.stage}>{stageOf(v.stage).label}</i></small></button>
      {v.summary ? <p>{v.summary}</p> : null}
      <Chips changes={v.changes} /><MediaLinks media={v.media} /><TestLine tests={v.tests} />
    </article>)}</div>
    <h3 className={css.betweenHead}>What changed from {a.label} to {b.label}</h3>
    {KINDS.map((k) => { const list = between.flatMap((v) => v.changes.filter((c) => c.kind === k.key).map((c) => ({ c, v })));
      return list.length ? <section key={k.key} className={css.kindGroup} style={tone(k.tone)} aria-label={k.label}><h4>{k.label}<small>{list.length}</small></h4>
        <ul>{list.map(({ c, v }, i) => <li key={i}>{c.text}<small>{v.label}</small></li>)}</ul></section> : null; })}
    {!between.some((v) => v.changes.length) ? <p className={hq.faint}>No changes are written down between these two versions yet.</p> : null}
  </section>;
}

/* ------------------------------------------------------------------------------------------------ sheets */

function VersionSheet({ open, version, product, canRemove, onClose, onSaved }: { open: string | null; version: Version | null; product: Product; canRemove: boolean; onClose: () => void; onSaved: () => void }) {
  const ref = useDialog(open !== null, onClose);
  return <dialog ref={ref} className={`${hq.sheet} ${hq.glassThick} ${css.sheet}`} aria-label={version ? `Version ${version.label}` : "New version"}>
    {open !== null ? <VersionForm key={version?.id ?? "new"} version={version} product={product} canRemove={canRemove} onClose={onClose} onSaved={onSaved} /> : null}
  </dialog>;
}

function VersionForm({ version, product, canRemove, onClose, onSaved }: { version: Version | null; product: Product; canRemove: boolean; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(version?.label ?? ""), [title, setTitle] = useState(version?.title ?? ""), [stage, setStage] = useState<Stage>(version?.stage ?? "live");
  const [releasedOn, setReleasedOn] = useState(version?.releasedOn ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  const [summary, setSummary] = useState(version?.summary ?? ""), [releaseRef, setReleaseRef] = useState(version?.releaseRef ?? "");
  const [changes, setChanges] = useState<Change[]>(version?.changes ?? []), [media, setMedia] = useState<Media[]>(version?.media ?? []);
  const [passed, setPassed] = useState(version?.tests.passed?.toString() ?? ""), [failed, setFailed] = useState(version?.tests.failed?.toString() ?? "");
  const [testUrl, setTestUrl] = useState(version?.tests.url ?? ""), [testNote, setTestNote] = useState(version?.tests.note ?? "");
  const [paste, setPaste] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirm, setConfirm] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    const lines = paste.split("\n").map((l) => l.replace(/^[•\-*]\s*/, "").trim()).filter(Boolean).map((text) => ({ kind: "new" as ChangeKind, text }));
    const body = { label, title, stage, releasedOn: releasedOn || null, summary, releaseRef, changes: [...changes.filter((c) => c.text.trim()), ...lines], media: media.filter((m) => m.url.trim()),
      tests: { passed, failed, url: testUrl, note: testNote } };
    try { if (version) await storyPost(`versions/${version.id}`, body); else await storyPost("versions", { productId: product.id, ...body }); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved"); setBusy(false); }
  };
  const remove = async () => { setBusy(true); try { await storyPost(`versions/${version!.id}/remove`); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); setBusy(false); } };
  return <>
    <div className={hq.sheetScroll}>
      <div className={hq.sheetHead}>
        <div><span className={hq.subhead}>{product.name} · {version ? "Version" : "New version"}</span>
          <div className={css.row2}><input className={css.labelInput} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="v1.0, Idea…" aria-label="Version label" maxLength={40} autoFocus={!version} />
            <input className={css.titleInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this version is" aria-label="Title" maxLength={120} /></div></div>
        <button type="button" className={hq.iconBtn} onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <div className={css.fields}>
        <label>Stage<select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <label>Released<input type="date" value={releasedOn} onChange={(e) => setReleasedOn(e.target.value)} /></label>
        <label>Release<input value={releaseRef} onChange={(e) => setReleaseRef(e.target.value)} placeholder="Tag or commit" maxLength={120} /></label>
      </div>
      <label className={css.block}>Summary<textarea className={hq.textarea} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What it was for, who it was for, what it could do" maxLength={4000} rows={3} /></label>
      <section className={css.block} aria-label="What changed"><h3>What changed</h3>
        {changes.map((c, i) => <div key={i} className={css.editRow}>
          <select value={c.kind} onChange={(e) => setChanges((x) => x.map((y, j) => j === i ? { ...y, kind: e.target.value as ChangeKind } : y))} aria-label="Kind of change">{KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
          <input value={c.text} onChange={(e) => setChanges((x) => x.map((y, j) => j === i ? { ...y, text: e.target.value } : y))} aria-label="Change" maxLength={300} />
          <button type="button" className={hq.iconBtn} onClick={() => setChanges((x) => x.filter((_, j) => j !== i))} aria-label="Remove this change"><X size={15} /></button></div>)}
        <button type="button" className={hq.secondary} onClick={() => setChanges((x) => [...x, { kind: "new", text: "" }])}><Plus size={15} aria-hidden="true" />Add a change</button>
        <textarea className={hq.textarea} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Or paste release notes: one change per line (added as New; change the kind after saving)" rows={2} aria-label="Paste changes" />
      </section>
      <section className={css.block} aria-label="Screens, videos and tutorials"><h3>Screens, videos and tutorials</h3>
        {media.map((m, i) => <div key={i} className={css.editRow}>
          <select value={m.kind} onChange={(e) => setMedia((x) => x.map((y, j) => j === i ? { ...y, kind: e.target.value as MediaKind } : y))} aria-label="Kind of link">{MEDIA.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
          <input value={m.url} onChange={(e) => setMedia((x) => x.map((y, j) => j === i ? { ...y, url: e.target.value } : y))} placeholder="https://…" aria-label="Link" inputMode="url" />
          <input value={m.label} onChange={(e) => setMedia((x) => x.map((y, j) => j === i ? { ...y, label: e.target.value } : y))} placeholder="Label" aria-label="Label" maxLength={120} />
          <button type="button" className={hq.iconBtn} onClick={() => setMedia((x) => x.filter((_, j) => j !== i))} aria-label="Remove this link"><X size={15} /></button></div>)}
        <button type="button" className={hq.secondary} onClick={() => setMedia((x) => [...x, { kind: "video", url: "", label: "" }])}><Plus size={15} aria-hidden="true" />Add a link</button>
      </section>
      <section className={css.block} aria-label="Tests"><h3>Tests</h3>
        <div className={css.fields}>
          <label>Passed<input inputMode="numeric" value={passed} onChange={(e) => setPassed(e.target.value.replace(/\D/g, ""))} /></label>
          <label>Failed<input inputMode="numeric" value={failed} onChange={(e) => setFailed(e.target.value.replace(/\D/g, ""))} /></label>
          <label>Run<input value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder="https://…" inputMode="url" /></label>
        </div>
        <input className={css.full} value={testNote} onChange={(e) => setTestNote(e.target.value)} placeholder="Note, e.g. “full CI green on GitHub-hosted runners”" aria-label="Test note" maxLength={300} />
      </section>
      {error ? <p className={hq.draftNote} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    </div>
    <div className={css.sheetFoot}>
      <button type="button" className={hq.primary} disabled={busy || !label.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className={hq.secondary} onClick={onClose}>Close</button>
      <span className={css.grow} />
      {version && canRemove ? (confirm ? <><span className={hq.faint}>Remove {version.label}?</span><button type="button" className={css.danger} onClick={() => void remove()} disabled={busy}>Remove</button></>
        : <button type="button" className={css.danger} onClick={() => setConfirm(true)}><Trash2 size={15} aria-hidden="true" />Remove</button>) : null}
    </div>
  </>;
}

function ProductSheet({ product, canRemove, onClose, onSaved }: { product: Product | "new" | null; canRemove: boolean; onClose: () => void; onSaved: (id: string | null) => void }) {
  const ref = useDialog(product !== null, onClose);
  const p = product && product !== "new" ? product : null;
  return <dialog ref={ref} className={`${hq.sheet} ${hq.glassThick} ${css.sheet}`} aria-label={p ? `Product ${p.name}` : "New product"}>
    {product !== null ? <ProductForm key={p?.id ?? "new"} product={p} canRemove={canRemove} onClose={onClose} onSaved={onSaved} /> : null}
  </dialog>;
}
function ProductForm({ product, canRemove, onClose, onSaved }: { product: Product | null; canRemove: boolean; onClose: () => void; onSaved: (id: string | null) => void }) {
  const [name, setName] = useState(product?.name ?? ""), [blurb, setBlurb] = useState(product?.blurb ?? ""), [repoUrl, setRepoUrl] = useState(product?.repoUrl ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const save = async () => { setBusy(true); setError(null);
    try { if (product) { await storyPost(`products/${product.id}`, { name, blurb, repoUrl }); onSaved(product.id); } else { const r = await storyPost<{ id: string }>("products", { name, blurb, repoUrl }); onSaved(r.id); } onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved"); setBusy(false); } };
  const remove = async () => { if (!product || !window.confirm(`Remove ${product.name} and its whole story?`)) return; setBusy(true);
    try { await storyPost(`products/${product.id}/remove`); onSaved(null); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); setBusy(false); } };
  return <>
    <div className={hq.sheetScroll}>
      <div className={hq.sheetHead}><div><span className={hq.subhead}>{product ? "Product" : "New product"}</span>
        <input className={css.titleInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Product or project name" aria-label="Product name" maxLength={80} autoFocus /></div>
        <button type="button" className={hq.iconBtn} onClick={onClose} aria-label="Close"><X size={17} /></button></div>
      <label className={css.block}>What it is<textarea className={hq.textarea} value={blurb} onChange={(e) => setBlurb(e.target.value)} maxLength={600} rows={3} /></label>
      <label className={css.block}>Where its code lives<input className={css.full} value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://… (optional)" inputMode="url" /></label>
      {error ? <p className={hq.draftNote} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    </div>
    <div className={css.sheetFoot}>
      <button type="button" className={hq.primary} disabled={busy || name.trim().length < 2} onClick={() => void save()}>{busy ? "Saving…" : product ? "Save" : "Create"}</button>
      <button type="button" className={hq.secondary} onClick={onClose}>Close</button><span className={css.grow} />
      {product && canRemove ? <button type="button" className={css.danger} onClick={() => void remove()} disabled={busy}><Trash2 size={15} aria-hidden="true" />Remove</button> : null}
    </div>
  </>;
}
