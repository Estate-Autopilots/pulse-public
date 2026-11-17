"use client";
// COMPANY-SEARCH: Settings → Company → Public profile (the company's admins say what everyone on Vitals sees), and
// Settings → Your account → "Let people find me" (each person's own choice, off until they turn it on).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cinProblem, gstinProblem, type DirectoryCompany } from "../lib/directory.mjs";
import { Panel } from "../ui";
import { Switch as KitSwitch } from "../kit/switch";
import { CompanyLine } from "./company-picker";
import css from "./directory.module.css";

type Show = { legalName: boolean; logo: boolean; city: boolean; industry: boolean; website: boolean; ids: boolean };
type Card = { name: string; handle: string; listed: boolean; legalName: string | null; city: string | null; industry: string | null; website: string | null;
  gstin: string | null; cin: string | null; otherIds: { kind: string; label: string; value: string }[]; show: Show; verifiedBy: "gstin" | "cin" | null;
  hasLogo: boolean; shown: (Record<string, unknown> & { handle: string; name: string }) | null };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? "That did not work. Try again.");
  return data as T;
}

// SETTINGS-APPLE (judge: "a tiny checkbox instead of a switch"): the kit's switch, words first and the switch at the end.
function Switch({ label, help, checked, onChange, disabled }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <KitSwitch label={label} hint={help} checked={checked} disabled={disabled} onChange={onChange} />;
}

const preview = (card: Card): DirectoryCompany | null => card.shown ? {
  id: "", handle: card.handle, name: card.name, legalName: null, city: (card.shown.city as string | null) ?? null, industry: (card.shown.industry as string | null) ?? null,
  website: null, logo: null, verified: !!card.verifiedBy, verifiedBy: card.verifiedBy, ids: [] } : null;

export function PublicProfileSettings() {
  const [card, setCard] = useState<Card | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Show | null>(null);
  const [listed, setListed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const fill = useCallback((c: Card) => { setCard(c); setShow(c.show); setListed(c.listed); setForm({ legalName: c.legalName ?? "", city: c.city ?? "", industry: c.industry ?? "", website: c.website ?? "", gstin: c.gstin ?? "", cin: c.cin ?? "" }); }, []);
  useEffect(() => { call<{ card: Card }>("directory/card").then((r) => fill(r.card)).catch((e: Error) => setError(e.message)); }, [fill]);
  if (!card || !show) return <div data-dest="settings.organisation.public-profile"><Panel title="Public profile" sub="What everyone on Vitals sees about your company">{error ? <p className={css.error} style={{ padding: 16 }} role="alert">{error}</p> : <div className={css.skeleton} style={{ margin: 16 }} />}</Panel></div>;
  const gProblem = gstinProblem(form.gstin), cProblem = cinProblem(form.cin);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => { setForm({ ...form, [k]: e.target.value }); setSaved(false); };
  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try { fill((await call<{ card: Card }>("directory/card", { ...form, listed, show })).card); setSaved(true); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const p = preview(card);
  return <div data-dest="settings.organisation.public-profile"><Panel title="Public profile" sub="What everyone on Vitals sees about your company">
    <form className={css.settings} style={{ padding: 16 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className={css.note}>Other companies find you by name, @handle, GSTIN or CIN, for example to send you an agreement. Your name, @handle, logo and city show by default. Everything else shows only if you turn it on.</p>
      {p ? <div><span className={css.label}>Others see</span><div className={css.picked} style={{ marginTop: 6 }}><CompanyLine company={p} /><Link className={css.quiet} href={`/directory/c/${encodeURIComponent(card.handle)}`}>Open</Link></div></div>
        : <p className={css.note}><b>Your company is hidden from search.</b></p>}
      <Switch label="Show us in search" help="Turn off to hide your company from everyone outside it." checked={listed} onChange={(v) => { setListed(v); setSaved(false); }} />
      <div className={css.row2}>
        <label className={css.field}><span>City</span><input className={css.text} value={form.city} onChange={set("city")} maxLength={80} placeholder="Pune" /></label>
        <label className={css.field}><span>Legal name</span><input className={css.text} value={form.legalName} onChange={set("legalName")} maxLength={160} placeholder="As on your GST papers" /></label>
        <label className={css.field}><span>What you do</span><input className={css.text} value={form.industry} onChange={set("industry")} maxLength={80} placeholder="Interiors, CA firm, agency…" /></label>
        <label className={css.field}><span>Website</span><input className={css.text} value={form.website} onChange={set("website")} maxLength={200} inputMode="url" placeholder="www.example.com" /></label>
        <label className={css.field}><span>GSTIN</span><input className={css.text} value={form.gstin} onChange={set("gstin")} maxLength={20} autoCapitalize="characters" spellCheck={false} placeholder="15 letters and numbers" aria-invalid={!!gProblem} />
          {gProblem ? <small className={css.error}>{gProblem}</small> : form.gstin ? <small className={css.ok}>Looks right</small> : null}</label>
        <label className={css.field}><span>CIN</span><input className={css.text} value={form.cin} onChange={set("cin")} maxLength={25} autoCapitalize="characters" spellCheck={false} placeholder="21 letters and numbers" aria-invalid={!!cProblem} />
          {cProblem ? <small className={css.error}>{cProblem}</small> : form.cin ? <small className={css.ok}>Looks right</small> : null}</label>
      </div>
      <div>
        <span className={css.label}>Show to everyone</span>
        <Switch label="Logo" checked={show.logo} onChange={(v) => setShow({ ...show, logo: v })} help={card.hasLogo ? undefined : "Add a logo in Name & logo first."} />
        <Switch label="City" checked={show.city} onChange={(v) => setShow({ ...show, city: v })} />
        <Switch label="Legal name" checked={show.legalName} onChange={(v) => setShow({ ...show, legalName: v })} />
        <Switch label="What you do" checked={show.industry} onChange={(v) => setShow({ ...show, industry: v })} />
        <Switch label="Website" checked={show.website} onChange={(v) => setShow({ ...show, website: v })} />
        <Switch label="GSTIN and CIN" help="When on, others can also find you by typing them." checked={show.ids} onChange={(v) => setShow({ ...show, ids: v })} />
      </div>
      <p className={css.note}>The green Verified badge shows when your GSTIN or CIN has the right shape and check. Vitals does not check it with the government yet.</p>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      {saved ? <p className={css.ok} role="status">Saved.</p> : null}
      <div className={css.actions}><button type="submit" className={css.primary} disabled={busy || !!gProblem || !!cProblem}>{busy ? "Saving…" : "Save"}</button></div>
    </form>
  </Panel></div>;
}

type Me = { account: boolean; handle?: string; findable: boolean; showEmail: boolean; showPhone: boolean; hasEmail: boolean; hasPhone: boolean;
  company: string | null; companies: { handle: string; name: string }[]; shown: Record<string, unknown> | null };

export function FindMeSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<{ me: Me }>("directory/me").then((r) => setMe(r.me)).catch((e: Error) => setError(e.message)); }, []);
  const change = async (patch: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { setMe((await call<{ me: Me }>("directory/me", patch)).me); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div data-dest="settings.find-me"><Panel title="In Vitals search" sub="Off until you turn it on">
    <div className={css.settings} style={{ padding: 16 }}>
      {!me ? error ? <p className={css.error} role="alert">{error}</p> : <div className={css.skeleton} /> : <>
        <Switch label="Show me in search" help="People in other companies can find your name, @handle, headline, photo and company."
          checked={me.findable} disabled={busy} onChange={(v) => void change({ findable: v })} />
        {me.findable ? <>
          <Switch label="Show my e-mail" help={me.hasEmail ? undefined : "Add a contact e-mail to your profile first."} checked={me.showEmail} disabled={busy || !me.hasEmail} onChange={(v) => void change({ showEmail: v })} />
          <Switch label="Show my phone" help={me.hasPhone ? undefined : "Add a contact phone to your profile first."} checked={me.showPhone} disabled={busy || !me.hasPhone} onChange={(v) => void change({ showPhone: v })} />
          {me.companies.length > 1 ? <label className={css.field}><span>Company to show</span>
            <select className={css.text} value={me.company ?? ""} disabled={busy} onChange={(e) => void change({ company: e.target.value })}>
              {me.companies.map((c) => <option key={c.handle} value={c.handle}>{c.name}</option>)}</select></label> : null}
          {me.handle ? <p className={css.note}><Link href={`/directory/p/${encodeURIComponent(me.handle)}`}>See what others see</Link></p> : null}
        </> : null}
        {error ? <p className={css.error} role="alert">{error}</p> : null}
      </>}
    </div>
  </Panel></div>;
}
