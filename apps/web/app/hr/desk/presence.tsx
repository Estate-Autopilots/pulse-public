"use client";
// HR → Policies → Office presence: the offices phones recognise (location, radius, office Wi-Fi), whether confirmed
// shoot sites from the map count, and whether automatic check-in is allowed at all.
import { MapPin, Plus, Trash2, Wifi } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Badge, Empty, Skeleton, styles } from "../../ui";
import css from "../desk.module.css";
import { dest } from "../../destinations/registry.mjs";
import { SaveBar, Switch, countChanges } from "../../kit";

type Network = { ssid: string; bssids: string };
type Office = { id?: string; name: string; coords: string; radius: number; wifi: Network[]; publicIpRanges: string; testFor?: string[] | null };
type Rules = { autoCheckOut: boolean; breakMaxMinutes: number; breakAllowedMinutes: number; breakPaid: boolean; graceMinutes: number; question: boolean; threshold: number };
type Presence = { rules?: Rules; suggestions?: { id: string; name: string; wifiCount: number; networkCount: number; peopleSeen: number }[]; offices: { id: string; name: string; lat: number; lng: number; radius: number; wifi: { ssid: string; bssids: string[] }[]; publicIpRanges?:string[]; testFor?: string[] | null }[]; dwellMinutes:number; leaveMinutes:number; autoCheckIn: boolean; sites: boolean; siteCount: number; siteLimit: number; canEdit: boolean };

const RULES: Rules = { autoCheckOut: true, breakMaxMinutes: 90, breakAllowedMinutes: 60, breakPaid: false, graceMinutes: 60, question: true, threshold: 60 };
const blank = (): Office => ({ name: "", coords: "", radius: 150, wifi: [], publicIpRanges:"" });
/** "28.4595, 77.0266" (as copied from a map) → numbers, or null. */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export function PresencePolicy() {
  const [data, setData] = useState<Presence | null>(null);
  const [offices, setOffices] = useState<Office[]>([]);
  const [auto, setAuto] = useState(false);
  const [dwell,setDwell]=useState(3),[leave,setLeave]=useState(15);
  const [sites, setSites] = useState(true);
  // ATT: the company's attendance rules (breaks, automatic check-out, the one question).
  const [rules, setRules] = useState<Rules>(RULES);
  const rule = (patch: Partial<Rules>) => setRules((r) => ({ ...r, ...patch }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // UI-POLISH-3: what the server holds, to count unsaved changes for the SaveBar and to discard them.
  const [saved, setSaved] = useState<{ offices: Office[]; auto: boolean; sites: boolean; dwell: number; leave: number; rules: Rules } | null>(null);
  const restore = (v: NonNullable<typeof saved>) => { setOffices(v.offices); setAuto(v.auto); setSites(v.sites); setDwell(v.dwell); setLeave(v.leave); setRules(v.rules); setError(""); };
  const apply = (d: Presence) => {
    const next = { offices: d.offices.map((o) => ({ id: o.id, name: o.name, coords: `${o.lat}, ${o.lng}`, radius: o.radius, publicIpRanges: (o.publicIpRanges ?? []).join(", "), testFor: o.testFor ?? null, wifi: o.wifi.map((w) => ({ ssid: w.ssid, bssids: w.bssids.join(", ") })) })),
      auto: d.autoCheckIn, sites: d.sites, dwell: d.dwellMinutes ?? 3, leave: d.leaveMinutes ?? 15, rules: d.rules ?? RULES };
    setData(d); setSaved(next);
    setOffices(next.offices); setAuto(next.auto); setSites(next.sites); setDwell(next.dwell); setLeave(next.leave); setRules(next.rules);
  };
  const fetchPresence = async () => {
    const r = await fetch("/api/v0/hr/presence", { cache: "no-store" }); const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? "Office presence is not available");
    return d as Presence;
  };
  useEffect(() => {
    let live = true;
    fetchPresence().then((d) => { if (live) apply(d); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  const can = !!data?.canEdit;
  // Each switch or figure is one change, and each office added, removed or edited is one.
  const changes = saved ? countChanges({ auto: saved.auto, sites: saved.sites, dwell: saved.dwell, leave: saved.leave }, { auto, sites, dwell, leave }) + countChanges(saved.rules, rules) + countChanges({ ...saved.offices }, { ...offices }) : 0;
  const edit = (i: number, patch: Partial<Office>) => setOffices(offices.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const officeBody = () => offices.map((o, i) => {
        const at = parseCoords(o.coords);
        if (!o.name.trim()) throw new Error(`Office ${i + 1} needs a name`);
        if (!at) throw new Error(`Paste the location of ${o.name} as “latitude, longitude”, e.g. 28.4595, 77.0266`);
        return { id: o.id ?? null, name: o.name, lat: at.lat, lng: at.lng, radius: o.radius, publicIpRanges:o.publicIpRanges.split(/[\s,;]+/).filter(Boolean), wifi: o.wifi.filter((w) => w.ssid.trim()).map((w) => ({ ssid: w.ssid.trim(), bssids: w.bssids.split(/[\s,;]+/).filter(Boolean) })) };
      });
  async function save(event: FormEvent | null, extra: Record<string, unknown> = {}) {
    event?.preventDefault(); setBusy(true); setError("");
    try {
      await post("hr/presence", { offices: officeBody(), autoCheckIn: auto, sites, dwellMinutes:dwell, leaveMinutes:leave, rules, ...extra });
      notify({ id: "presence", tone: "success", title: "Office presence saved", timeout: 2500 }); apply(await fetchPresence());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!data) return <section className={styles.panel}>{error ? <Empty icon={MapPin} title="Office presence is not available" text={error} /> : <div style={{ display: "grid", gap: 10, padding: 16 }} aria-busy="true"><Skeleton width="40%" /><Skeleton height={72} /><Skeleton height={72} /></div>}</section>;
  return (
    <form className={`${styles.panel} ${css.rulesPane}`} onSubmit={save}>
      <div className={styles.panelHead}><h3 className={styles.panelTitle}>Office presence<small>Phones suggest a check-in on arrival at an office or on its Wi-Fi. Pulse keeps which office matched, never anyone’s location.</small></h3></div>
      <fieldset className={css.presence} disabled={!can || busy}>
        <div className={css.switchList}>
          <div {...dest("hr.policies.presence.auto")}><Switch checked={auto} onChange={setAuto} label="Allow automatic check-in at an office"
            hint="Off: Pulse only asks “You’re at the office — check in?”. On: a person who also turns it on in their app is checked in by themselves once Pulse is sure (one strong signal or two that agree, through the dwell), with a one-tap “That’s me”." /></div>
          <Switch checked={sites} onChange={setSites} label="Suggest check-in at confirmed shoot sites"
            hint={`${data.siteCount} map pins have an exact or building location; the ${Math.min(data.siteLimit, data.siteCount)} most recently confirmed are used, as “On duty”.`} />
        </div>
        <div className={css.officeGrid}>
          <label className={styles.field}>Arrival dwell · minutes<input type="number" min="1" max="30" value={dwell} onChange={e=>setDwell(Number(e.target.value))}/><span className={css.hint}>Pulse must be sure this long before it checks in or asks.</span></label>
          <label className={styles.field}>Gone for · minutes<input type="number" min="1" max="120" value={leave} onChange={e=>setLeave(Number(e.target.value))}/><span className={css.hint}>Every signal gone this long means they left (one missed report changes nothing).</span></label>
        </div>
        <section className={css.attRules} aria-label="Breaks and check-out" {...dest("hr.policies.presence.rules")}>
          <h4>Breaks and check-out</h4>
          <div className={css.switchList}><Switch checked={rules.autoCheckOut} onChange={(on) => rule({ autoCheckOut: on })} label="Check out by itself when someone leaves"
            hint="At the last moment Pulse was sure they were at the office; with no signal at all, at the end of the shift once the grace below has passed. Marked “automatic”; the unsure ones wait for you in Attendance → To check. Off: Pulse asks once instead." /></div>
          <div className={css.officeGrid}>
            <label className={styles.field}>Grace after the shift · minutes<input type="number" min="0" max="480" value={rules.graceMinutes} onChange={(e) => rule({ graceMinutes: Number(e.target.value) })} /><span className={css.hint}>Time to check out yourself before Pulse does it at the shift’s end.</span></label>
            <label className={styles.field}>Longest break Pulse records · minutes<input type="number" min="10" max="240" value={rules.breakMaxMinutes} onChange={(e) => rule({ breakMaxMinutes: Number(e.target.value) })} /><span className={css.hint}>Away and back is a break (lunch, a call outside). Away longer in the middle of the day: Pulse asks once.</span></label>
            <label className={styles.field}>Break time allowed a day · minutes<input type="number" min="0" max="240" value={rules.breakAllowedMinutes} onChange={(e) => rule({ breakAllowedMinutes: Number(e.target.value) })} /><span className={css.hint}>More than this shows in To check, once a day.</span></label>
          </div>
          <div className={css.switchList}>
            <Switch checked={rules.breakPaid} onChange={(on) => rule({ breakPaid: on })} label="Breaks are paid" hint="Off: break time is not counted as time worked." />
            <Switch checked={rules.question} onChange={(on) => rule({ question: on })} label="Ask once when the signals disagree"
              hint="For example the laptop is busy somewhere else after leaving the office. At most once a day, between 08:00 and 21:30, with one-tap answers (“Yes, I left at 18:40” / “Still working”); never asked again once answered." />
          </div>
          <label className={styles.field}>How sure Pulse must be · out of 100<input type="number" min="30" max="100" value={rules.threshold} onChange={(e) => rule({ threshold: Number(e.target.value) })} /><span className={css.hint}>60: the office access point alone (70), or two that agree: phone at the office 50, office network 40, Wi-Fi name 30. Laptop in use (15) and Pulse open on the phone (10) only add to those.</span></label>
        </section>
        {(data.suggestions ?? []).length ? <section className={css.attSeen} aria-label="From what Pulse has seen">
          <h4>From what Pulse has seen</h4>
          {(data.suggestions ?? []).map((g) => <p key={g.id}><span><b>{g.name}</b> is a test office for {offices.find((o) => o.id === g.id)?.testFor?.join(", ") ?? "one person"}: {g.wifiCount} Wi-Fi network{g.wifiCount === 1 ? "" : "s"}, {g.networkCount} office network{g.networkCount === 1 ? "" : "s"}, seen with {g.peopleSeen} {g.peopleSeen === 1 ? "person" : "people"}. If it is the company’s office, use it for everyone.</span>
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!can || busy} onClick={() => void save(null, { openToEveryone: g.id })}>Use it for everyone</button></p>)}
        </section> : null}
        {offices.map((o, i) => {
          const at = parseCoords(o.coords);
          return <article key={o.id ?? `new-${i}`} className={css.office}>
            <div className={css.officeHead}><MapPin size={16} aria-hidden="true" /><b>{o.name || "New office"}</b>{o.testFor?.length ? <Badge tone="accent">{`Test office · only ${o.testFor.join(", ")}`}</Badge> : null}{at ? <a href={`https://www.google.com/maps?q=${at.lat},${at.lng}`} target="_blank" rel="noreferrer">Check on a map ↗</a> : <Badge tone="warning">Location needed</Badge>}
              <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => setOffices(offices.filter((_, j) => j !== i))} aria-label={`Remove ${o.name || "this office"}`}><Trash2 size={14} aria-hidden="true" /></button></div>
            <div className={css.officeGrid} {...dest("hr.policies.presence.office")}>
              <label className={styles.field}>Name<input value={o.name} onChange={(e) => edit(i, { name: e.target.value })} maxLength={80} placeholder="Head office, Pune" required /></label>
              <label className={styles.field}>Location<input value={o.coords} onChange={(e) => edit(i, { coords: e.target.value })} placeholder="28.4595, 77.0266" inputMode="decimal" required />
                <span className={css.hint}>In Google Maps: right-click the building → click the numbers to copy them.</span></label>
              <label className={styles.field}>Radius · {o.radius} m<input type="range" min="50" max="1000" step="10" value={o.radius} onChange={(e) => edit(i, { radius: Number(e.target.value) })} />
                <span className={css.hint}>150 m suits one building; larger radii catch people in the car park or next door.</span></label>
            </div>
            <label className={styles.field} {...dest("hr.policies.presence.ip")}>Office public IP addresses / CIDR ranges<input value={o.publicIpRanges} onChange={e=>edit(i,{publicIpRanges:e.target.value})} placeholder="203.0.113.10/32, 2001:db8::/64"/><span className={css.hint}>Use the office internet connection’s public address. Pulse checks it on the server; it never stores the person’s IP history.</span></label>
            <div className={css.wifi} {...dest("hr.policies.presence.wifi")}>
              <span className={css.wifiTitle}><Wifi size={14} aria-hidden="true" /> Office Wi-Fi <small>Works indoors when GPS is weak. The access-point address (BSSID) makes it reliable; the name alone only ever suggests.</small></span>
              {o.wifi.map((w, k) => <div key={k} className={css.wifiRow}>
                <input aria-label="Wi-Fi name (SSID)" value={w.ssid} onChange={(e) => edit(i, { wifi: o.wifi.map((x, n) => (n === k ? { ...x, ssid: e.target.value } : x)) })} placeholder="Network name, e.g. Office-WiFi" maxLength={32} />
                <input aria-label="Access-point addresses (BSSID)" value={w.bssids} onChange={(e) => edit(i, { wifi: o.wifi.map((x, n) => (n === k ? { ...x, bssids: e.target.value } : x)) })} placeholder="a4:2b:b0:11:22:33, a4:2b:b0:11:22:34" />
                <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => edit(i, { wifi: o.wifi.filter((_, n) => n !== k) })} aria-label="Remove this network"><Trash2 size={14} aria-hidden="true" /></button>
              </div>)}
              <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => edit(i, { wifi: [...o.wifi, { ssid: "", bssids: "" }] })} disabled={o.wifi.length >= 10}><Plus size={14} aria-hidden="true" /> Add a Wi-Fi network</button>
            </div>
          </article>;
        })}
        {!offices.length ? <p className={css.hint}>No offices yet. Add one so phones can suggest checking in on arrival.</p> : null}
        <button type="button" className={styles.btn} onClick={() => setOffices([...offices, blank()])} disabled={offices.length >= 20} {...dest("hr.policies.presence.office")}><Plus size={14} aria-hidden="true" /> Add an office</button>
      </fieldset>
      {/* UI-POLISH-3: the kit's SaveBar (unsaved count, Discard, Save). */}
      {can ? <div className={css.formFoot}><SaveBar changes={changes} busy={busy} error={error} onSave={() => void save(null)} onDiscard={saved ? () => restore(saved) : undefined} saveLabel="Save office presence" /></div>
        : <p className={css.formNote}>HR and organisation admins set office presence. Every change is kept in the change history.</p>}
    </form>
  );
}
