import { BRAND, DIRECTIONS, LIVE, appIconSvg, lockupSvg, markSvg, wordmarkSvg } from "@pulse/design-system/brand";
import { PIP_LABELS, pipSvg, type Mood } from "@pulse/companion";
import { Page, PageHeader } from "../ui";
import { PipStage } from "./stage";
import { orgLogo } from "../lib/brand";
import { readBrand } from "../lib/brand-server";
import css from "./brand.module.css";

// The brand sheet (UX-NOTIFY, dev only until the owner approves): five directions for the mark with a recommendation
// (LAYOUT-SWEEP), the mark from favicon to app tile, Pip's states, and every app icon as the platforms show it.
// Everything is drawn from packages/design-system/src/brand.js and packages/companion/src/pip.js.

const svg = (html: string, className?: string, key?: number) => <span key={key} className={className ?? css.art} dangerouslySetInnerHTML={{ __html: html }} />;
const ISLAND: Mood[] = ["idle", "listening", "thinking", "new-message", "happy", "concerned", "sleeping"];
const DAY: Mood[] = ["waking", "in", "break", "done", "celebrate"];
const NOTES: Partial<Record<Mood, string>> = {
  idle: "Breathes and blinks", listening: "Head tilts; the point sends ripples", thinking: "Glances up; three dots take turns",
  "new-message": "Perks up once; wide eyes", happy: "Two hops; a grin", concerned: "Worried brows; a slow sway", sleeping: "Closed eyes, drifting z's, after hours",
  waking: "A stretch before the workday", in: "The point beats while you are checked in", break: "A cup of tea", done: "Waves goodbye", celebrate: "Confetti for a first or on-time check-in",
};

export const metadata = { title: "Brand · Pulse" };

export default async function BrandPage() {
  const org = orgLogo(await readBrand());
  return (
    <Page>
      <PageHeader title="Pulse brand" context={["Logo, Pip and app icons", "Dev preview: the owner approves before anything ships"]} />
      <section className={css.section} aria-labelledby="brand-directions">
        <h2 id="brand-directions" className={css.heading}>Five directions for the Pulse mark</h2>
        <p className={css.lead}>Drawn on the same 32-point grid in solid shapes only (no thin lines), and judged at 16 px (a browser tab), 32 px (an icon) and as an app tile. One is recommended; the mark in use stays until you choose.</p>
        <div className={css.directions}>
          {DIRECTIONS.map((d) => (
            <article key={d.id} className={css.direction} data-chosen={d.recommended ? "" : undefined} aria-label={`${d.name}${d.recommended ? ", recommended" : ""}`}>
              <header><h3>{d.name}</h3>{d.recommended ? <span className={css.chosen}>Recommended</span> : null}</header>
              <div className={css.sizes}>{[16, 24, 32, 64, 128].map((s) => svg(markSvg({ size: s, direction: d.id, id: `dir-${d.id}-${s}`, radius: s <= 16 ? 7 : 9 }), css.size, s))}</div>
              <div className={css.monos}>
                <span className={css.onLight}>{svg(markSvg({ size: 56, tile: false, direction: d.id, color: BRAND.ink }))}</span>
                <span className={css.onDark}>{svg(markSvg({ size: 56, tile: false, direction: d.id, color: "#ffffff" }))}</span>
              </div>
              <p className={css.idea}>{d.idea}</p>
              <p className={css.verdict}>{d.verdict}</p>
            </article>
          ))}
          <article className={css.direction} data-live="" aria-label={`${LIVE.name}, chosen`}>
            <header><h3>{LIVE.name}</h3><span className={css.inUse}>In use</span></header>
            <div className={css.sizes}>{[16, 24, 32, 64, 128].map((s) => svg(markSvg({ size: s, id: `live-${s}`, radius: s <= 16 ? 7 : 9 }), css.size, s))}</div>
            <p className={css.idea}>{LIVE.idea}</p>
            <p className={css.verdict}>{LIVE.verdict}</p>
          </article>
        </div>
        <h3 className={css.subheading}>The recommendation in place, beside Pip</h3>
        <div className={css.inPlace}>
          <span className={css.tab}>{svg(markSvg({ size: 16, direction: "blink", radius: 7, id: "place-tab" }))}<span>Pulse · Estate Autopilots</span></span>
          <span className={css.ios}>{svg(markSvg({ size: 72, direction: "blink", radius: 0, scale: 0.92, id: "place-ios" }))}</span>
          <span className={css.onDark}>{svg(markSvg({ size: 40, direction: "blink", id: "place-dark" }))}</span>
          <span className={css.pairPip}>{svg(markSvg({ size: 64, direction: "blink", id: "place-pair" }))}{svg(pipSvg({ mood: "idle", size: 80, uid: "brand-pair", still: true }))}</span>
        </div>
        <p className={css.verdict}>Pip keeps its pebble, eyes and live point; with Blink the app icon is Pip’s face, so the bot and the mark are one character. Choosing it changes MARK in packages/design-system/src/brand.js; the icon scripts redraw every app icon from it.</p>
      </section>

      {org ? <section className={css.section} aria-labelledby="brand-org">
        <h2 id="brand-org" className={css.heading}>{org.name}: the organisation&apos;s own logo</h2>
        <p className={css.lead}>Each organisation sets its own in Settings → Organisation. Pulse shows the square mark at the top of the navigation rail and the lock-up on the sign-in page, in e-mails, on printed copies and in the phone&apos;s page list.</p>
        {/* eslint-disable @next/next/no-img-element -- the organisation's logo, served by the app */}
        <div className={css.lockups}>
          {org.mark ? <span className={css.onLight}><img src={org.mark} alt={`${org.name} mark`} height={56} /></span> : null}
          {org.logo ? <span className={css.onLight}><img src={org.logo} alt={`${org.name} logo`} height={56} /></span> : null}
          {org.logoDark || org.logo ? <span className={css.onDark}><img src={org.logoDark ?? org.logo!} alt={`${org.name} logo on dark`} height={56} /></span> : null}
        </div>
        {/* eslint-enable @next/next/no-img-element */}
      </section> : null}

      <section className={css.section} aria-labelledby="brand-mark">
        <h2 id="brand-mark" className={css.heading}>The mark and the wordmark</h2>
        <p className={css.lead}>An open P whose bowl holds the live point. The wordmark is Inter at weight 640, tracked −2 %, drawn as outlines. Leave at least half the mark&apos;s width clear around the lockup.</p>
        <div className={css.lockups}>
          <span className={css.onLight}>{svg(lockupSvg({ height: 56, id: "lock-light" }))}</span>
          <span className={css.onDark}>{svg(lockupSvg({ height: 56, theme: "dark", id: "lock-dark" }))}</span>
          <span className={css.onLight}>{svg(lockupSvg({ height: 40, mono: BRAND.ink }))}</span>
          <span className={css.onDark}>{svg(lockupSvg({ height: 40, mono: "#ffffff" }))}</span>
          <span className={css.onLight}>{svg(wordmarkSvg({ height: 28 }))}</span>
          <span className={css.onDark}>{svg(wordmarkSvg({ height: 28, color: "#ffffff" }))}</span>
        </div>
        <div className={css.ramp} aria-label="The mark from a 16 px favicon to a 180 px app tile">
          {[16, 20, 24, 32, 48, 64, 96, 128, 180].map((s) => <figure key={s}>{svg(markSvg({ size: s, radius: s <= 16 ? 7 : 9, id: `ramp-${s}` }))}<figcaption>{s}</figcaption></figure>)}
        </div>
        <ul className={css.swatches} aria-label="Brand colours">
          {([["Iris", BRAND.iris], ["Iris light", BRAND.irisLight], ["Iris deep", BRAND.irisDeep], ["Lilac (dark mode)", BRAND.lilac], ["Ink", BRAND.ink], ["Live point", BRAND.live]] as const).map(([name, hex]) => (
            <li key={name}><span style={{ background: hex }} aria-hidden="true" /><b>{name}</b><code>{hex}</code></li>
          ))}
        </ul>
      </section>

      <section className={css.section} aria-labelledby="brand-pip">
        <h2 id="brand-pip" className={css.heading}>Pip, the Pulse bot</h2>
        <p className={css.lead}>One pebble, two eyes and the live point: the same dot as the logo&apos;s. CSS motion only, under 1 KB per state, and still poses when the computer asks for reduced motion.</p>
        <PipStage>
          <h3 className={css.subheading}>Island states</h3>
          <div className={css.pips}>{ISLAND.map((m) => <figure key={m} className={css.pip}>{svg(pipSvg({ mood: m, size: 96, uid: `brand-${m}` }))}<figcaption><b>{m}</b><span>{NOTES[m]}</span></figcaption></figure>)}</div>
          <h3 className={css.subheading}>The workday</h3>
          <div className={css.pips}>{DAY.map((m) => <figure key={m} className={css.pip}>{svg(pipSvg({ mood: m, size: 96, uid: `brand-${m}` }))}<figcaption><b>{m}</b><span>{NOTES[m]}</span></figcaption></figure>)}</div>
          <div className={css.pipSizes} aria-label="Pip from 20 to 64 pixels">{[20, 24, 28, 36, 48, 64].map((s) => svg(pipSvg({ mood: "idle", size: s, uid: `pip-size-${s}`, label: `${PIP_LABELS.idle}, ${s} pixels` }), undefined, s))}</div>
        </PipStage>
      </section>

      <section className={css.section} aria-labelledby="brand-icons">
        <h2 id="brand-icons" className={css.heading}>App icons</h2>
        <p className={css.lead}>Generated from the masters by each platform&apos;s icon script. The web icons are live on dev now; the native apps pick theirs up at their next build.</p>
        <div className={css.icons}>
          <figure><span className={css.dock}>{svg(appIconSvg({ size: 112, platform: "mac" }))}</span><figcaption><b>macOS</b><span>Big Sur grid, soft shadow</span></figcaption></figure>
          <figure>{svg(appIconSvg({ size: 96 }))}<figcaption><b>Windows</b><span>Taskbar, Start, installer</span></figcaption></figure>
          <figure><span className={css.ios}>{svg(appIconSvg({ size: 96, platform: "ios" }))}</span><figcaption><b>iPhone</b><span>Full-bleed; iOS rounds it</span></figcaption></figure>
          <figure><span className={css.round}>{svg(appIconSvg({ size: 96, platform: "maskable" }))}</span><figcaption><b>Android</b><span>Adaptive: iris background, white mark</span></figcaption></figure>
          <figure><span className={css.chrome}>{[16, 32, 48].map((s) => svg(markSvg({ size: s, radius: s === 16 ? 7 : 9, id: `chrome-${s}` }), undefined, s))}</span><figcaption><b>Chrome</b><span>Toolbar 16–48, store 128</span></figcaption></figure>
          <figure><span className={css.tab}>{svg(markSvg({ size: 16, radius: 7, id: "tab-16" }))}<span>Pulse · Estate Autopilots</span></span><figcaption><b>Web</b><span>Favicon, apple-touch, manifest</span></figcaption></figure>
          <figure><span className={css.tray}>{svg(markSvg({ size: 22, tile: false, color: "#000000" }))}{svg(markSvg({ size: 22, id: "tray-win" }))}</span><figcaption><b>Tray</b><span>macOS template · Windows colour</span></figcaption></figure>
        </div>
        <dl className={css.releases}>
          <div><dt>Web</dt><dd>On pulse-dev now (dev/live); production with the next approved web release.</dd></div>
          <div><dt>Desktop (Mac and Windows)</dt><dd>The first build after 1.0.1, i.e. 1.0.2: app icon, installer and tray icons.</dd></div>
          <div><dt>Android and iPhone</dt><dd>The first phone build after 1.1.1, i.e. 1.1.2: launcher and adaptive icon, splash, notification icon, App Store icon.</dd></div>
          <div><dt>Chrome extension</dt><dd>The first package after 1.0.0, i.e. 1.0.1: toolbar and store icons.</dd></div>
          <div><dt>Masters</dt><dd><code>packages/design-system/brand/</code> (SVG) from <code>src/brand.js</code>; Pip from <code>packages/companion/src/pip.js</code>.</dd></div>
        </dl>
      </section>
    </Page>
  );
}
