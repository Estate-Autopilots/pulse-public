'use client';
import { useMemo, useState } from 'react';
import { Apple, Chrome, Monitor, Search, Smartphone } from 'lucide-react';
import { Badge, styles } from '../ui';
import css from './team.module.css';

export type HealthDevice = {
  personId: string; personName: string; deviceId: string; name: string; platform: string; appVersion: string | null; lastSeen: string | null;
  lastAttendance: string | null; lastEvent: string | null; events7d: number; connected: 'connected' | 'quiet' | 'not-seen';
  attendance: 'working' | 'none-yet'; activity: { state: 'on' | 'off' | 'paused' | 'not-applicable'; why: string }; pings: 'ok' | 'blocked'; presence: 'on' | 'off';
};
export type HealthData = { attendanceEnabled?: boolean; devices: HealthDevice[]; peopleWithDevices: number; people: number };

const ICON = { windows: Monitor, macos: Apple, android: Smartphone, ios: Smartphone, chrome: Chrome } as Record<string, typeof Monitor>;
const PLATFORM = { windows: 'Windows', macos: 'Mac', android: 'Android', ios: 'iPhone', chrome: 'Chrome' } as Record<string, string>;
const when = (v: string | null) => {
  if (!v) return 'never';
  const m = Math.round((Date.now() - Date.parse(v)) / 60000);
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Admin and leadership: is each person's app connected and is tracking working, without asking anyone. */
export function TrackingHealth({ data }: { data: HealthData }) {
  const [q, setQ] = useState('');
  const people = useMemo(() => {
    const map = new Map<string, { name: string; devices: HealthDevice[] }>();
    for (const d of data.devices) { const p = map.get(d.personId) ?? { name: d.personName, devices: [] }; p.devices.push(d); map.set(d.personId, p); }
    return [...map.values()].filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  }, [data, q]);
  return (
    <section className={css.team} aria-labelledby="tracking-health-title">
      <header className={css.head}>
        <div><h2 id="tracking-health-title">Devices & tracking health</h2>
          <p>{`${data.peopleWithDevices} of ${data.people} people have a Pulse app connected. Connection and whether optional work activity is on, with the reason when it is off.${data.attendanceEnabled === true ? ' Attendance from the app is also shown.' : ''} No activity contents, messages or locations are shown here.`}</p></div>
        <label className={css.search}><Search size={14} aria-hidden="true" /><input type="search" aria-label="Find a person" placeholder="Find a person" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </header>
      {people.length ? <div className={css.people}>{people.map((p) => (
        <article key={p.name} className={css.person}>
          <h3>{p.name}</h3>
          <ul className={css.devices}>{p.devices.map((d) => { const Icon = ICON[d.platform] ?? Monitor; return (
            <li key={d.deviceId} className={css.device}>
              <Icon size={18} aria-hidden="true" />
              <div className={css.deviceMain}>
                <strong>{`${PLATFORM[d.platform] ?? d.platform} · ${d.name}`}</strong>
                <small>{`Pulse ${d.appVersion ?? 'version unknown'} · last seen ${when(d.lastSeen)}`}</small>
              </div>
              <div className={css.badges}>
                <Badge tone={d.connected === 'connected' ? 'success' : d.connected === 'quiet' ? 'warning' : 'danger'}>{d.connected === 'connected' ? 'Connected' : d.connected === 'quiet' ? 'Quiet this week' : 'Not seen'}</Badge>
                {data.attendanceEnabled === true ? <Badge tone={d.attendance === 'working' ? 'success' : 'neutral'}>{d.attendance === 'working' ? `Attendance from app · ${when(d.lastAttendance)}` : 'No check-in from this app yet'}</Badge> : null}
                {d.activity.state !== 'not-applicable' ? <Badge tone={d.activity.state === 'on' ? 'success' : d.activity.state === 'paused' ? 'warning' : 'neutral'}>{`Work activity ${d.activity.state} · ${d.activity.why}${d.lastEvent ? ` · last event ${when(d.lastEvent)}` : ''}`}</Badge> : null}
                {d.pings === 'blocked' ? <Badge tone="warning">Pings blocked on device</Badge> : null}
                {d.presence === 'on' ? <Badge tone="accent">Office presence on</Badge> : null}
              </div>
            </li>); })}</ul>
        </article>
      ))}</div> : <p className={styles.muted}>{q ? 'Nobody matches that name.' : 'No Pulse apps are connected yet.'}</p>}
    </section>
  );
}
