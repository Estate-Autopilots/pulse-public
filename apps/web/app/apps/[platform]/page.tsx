import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { pipSvg } from "@pulse/companion";
import { installOrigin, publishedPhone, publishedUpdate } from "../../lib/app-updates";
import { GUIDES, guideBySlug, guideSteps, phoneHint } from "../../settings/app-guides";
import css from "../apps.module.css";

export const dynamicParams = false;
export function generateStaticParams() { return GUIDES.map((g) => ({ platform: g.slug })); }
export async function generateMetadata({ params }: { params: Promise<{ platform: string }> }) {
  const g = guideBySlug((await params).platform);
  return { title: g ? `Install Pulse for ${g.title}` : "Install Pulse" };
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

/** The install page sent to testers: one platform, its public download, the steps in plain words and screenshots.
 *  Needs no sign-in; the app itself signs in with the person's Pulse account. */
export default async function InstallPage({ params }: { params: Promise<{ platform: string }> }) {
  const g = guideBySlug((await params).platform);
  if (!g) notFound();
  const desktop = g.key === "windows" || g.key === "macos";
  const origin = installOrigin(await headers());
  const [release, phone] = await Promise.all([publishedUpdate("test", desktop ? "desktop" : "companion"), g.key === "android" ? publishedPhone("android", origin) : null]);
  // Computers install the desktop release; Android offers the phone app built for this address from its own download
  // pointer, never the retired Expo build in the update channel or another address's app.
  const files = g.key === "android" ? (phone ? [phone] : []) : (release?.files ?? []).filter((f) => f.platform === g.key);
  const version = g.key === "android" ? phone?.name.match(/^Pulse-(\d+\.\d+\.\d+)-/)?.[1] : release?.version;
  return (
    <div className={css.page}>
      <header className={css.hero}>
        <span className={css.pip} dangerouslySetInnerHTML={{ __html: pipSvg({ mood: "waking", size: 88, uid: "install" }) }} />
        <div>
          <p className={css.eyebrow}>{version ? `Pulse ${version}` : "Pulse"}</p>
          <h1>{`Pulse for ${g.title}`}</h1>
          <p className={css.lead}>{g.what}</p>
          <div className={css.downloads}>
            {g.kinds.map(({ kind, label }, i) => {
              const f = files.find((x) => x.name.toLowerCase().includes(kind) || x.name.endsWith(`.${kind}`));
              return f?.url ? <a key={kind} className={`${css.button} ${i === 0 ? css.primary : ""}`} href={f.url}><Download size={16} aria-hidden="true" />{`${label} · ${mb(f.size)}`}</a> : null;
            })}
            {g.pending ? <span className={css.pending}>{g.pending}</span> : null}
            {g.key === "android" && !phone ? <span className={css.hint}>{phoneHint(origin)}</span> : null}
          </div>
        </div>
      </header>
      <section className={css.steps} aria-labelledby="steps-title">
        <h2 id="steps-title">How to install</h2>
        <ol>{guideSteps(g, origin).map((s) => <li key={s}>{s}</li>)}</ol>
      </section>
      {g.shots.length ? <section className={css.shots} aria-label="Screenshots">{g.shots.map((s) => <figure key={s.src}>
        {/* eslint-disable-next-line @next/next/no-img-element -- small static screenshots shown at their own size */}
        <img src={s.src} alt={s.alt} loading="lazy" />
        <figcaption>{s.alt}</figcaption></figure>)}</section> : null}
      <p className={css.foot}>{g.key === "android"
        ? "Questions or something not working? Use Send feedback under Get the apps in Pulse Settings. For updates, open Settings → Devices → This phone. Android asks you to confirm each installation."
        : "Questions or something not working? Use Send feedback in the app’s Settings → Updates & about. Updates arrive by themselves once Pulse is installed."}</p>
      <nav className={css.others} aria-label="Other devices">{GUIDES.filter((x) => x.slug !== g.slug).map((x) => <a key={x.slug} href={`/apps/${x.slug}`}>{x.title}</a>)}</nav>
    </div>
  );
}
