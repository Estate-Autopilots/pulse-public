import { headers } from "next/headers";
import { Download, Monitor, Smartphone, Tablet } from "lucide-react";
import { installOrigin } from "../../lib/app-updates";
import { qrSvg } from "../../lib/qr.mjs";
import { vitalsDownloads, type VitalsFile } from "./vitals-downloads";
import { IphoneHint } from "./iphone-hint";
import css from "./get.module.css";

export const metadata = { title: "Get Vitals OS" };
export const dynamic = "force-dynamic";

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const day = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : null; };

function Card({ id, icon: Icon, title, what, file, extra, qr, qrLabel, steps, note }: {
  id: string; icon: typeof Monitor; title: string; what: string; file?: VitalsFile; extra?: VitalsFile; qr: string; qrLabel: string; steps: string[]; note?: string;
}) {
  const built = file ? day(file.builtAt) : null;
  return <article id={id} className={css.card} aria-labelledby={`${id}-title`}>
    <header className={css.cardHead}>
      <span className={css.badgeIcon} aria-hidden="true"><Icon size={22} /></span>
      <div>
        <h2 id={`${id}-title`}>{title}</h2>
        <p className={css.meta}>{file ? `Version ${file.version} · ${mb(file.size)}${built ? ` · ${built}` : ""}` : note ?? "Not available yet"}</p>
      </div>
    </header>
    <p className={css.what}>{what}</p>
    <div className={css.body}>
      <div className={css.actions}>
        {file ? <a className={`${css.button} ${css.primary}`} href={`/apps/get/${file.name}`} download data-testid={`download-${id}`}><Download size={16} aria-hidden="true" />{`Download ${file.kind === "apk" ? "for Android" : "Setup (.exe)"}`}</a> : null}
        {extra ? <a className={css.button} href={`/apps/get/${extra.name}`} download><Download size={16} aria-hidden="true" />{`Managed installer (.msi) · ${mb(extra.size)}`}</a> : null}
        {id === "iphone" ? <IphoneHint /> : null}
        <ol className={css.steps}>{steps.map((s) => <li key={s}>{s}</li>)}</ol>
        {file ? <p className={css.hash} title="SHA-256 checksum">{`SHA-256 ${file.sha256}`}</p> : null}
      </div>
      <figure className={css.qr}>
        <span dangerouslySetInnerHTML={{ __html: qrSvg(qr, 148, qrLabel) }} />
        <figcaption>{qrLabel}</figcaption>
      </figure>
    </div>
  </article>;
}

/** PULSE-APPS (owner, 6 Nov 2026): one page to get Vitals OS on every device: Android, Windows and iPhone, with a QR code
 *  for each, the version and the size. Public, like the install guides, so it works on a phone that is not signed in. */
export default async function GetVitalsOS() {
  const origin = installOrigin(await headers()) ?? "https://app.vitalsos.ai";
  const files = await vitalsDownloads();
  const apk = files.find((f) => f.kind === "apk"), exe = files.find((f) => f.kind === "exe"), msi = files.find((f) => f.kind === "msi");
  return (
    <div className={css.page}>
      <header className={css.hero}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the app icon at its own size */}
        <img className={css.logo} src="/icons/vitals-os-192.png" alt="" width={72} height={72} />
        <div>
          <h1>Get Vitals OS</h1>
          <p className={css.lead}>{`One app for every company you work with. Sign in once and switch companies inside the app. Everything opens ${origin.replace("https://", "")}.`}</p>
        </div>
      </header>
      <div className={css.grid}>
        <Card id="android" icon={Smartphone} title="Android" file={apk}
          what="The full Vitals OS as a phone app, with notifications, links that open in the app, camera uploads and check-in."
          qr={apk ? `${origin}/apps/get/${apk.name}` : `${origin}/apps/get#android`} qrLabel="Scan with your Android phone to download"
          steps={[
            "Tap Download on your phone, or scan the code with the phone’s camera.",
            "Open the downloaded file. If Android asks, allow your browser to install apps (Install unknown apps).",
            "Already have the Pulse app? Install this over it: you stay signed in and nothing is lost.",
            "Open Vitals OS, sign in, then turn on notifications when it asks.",
          ]} />
        <Card id="windows" icon={Monitor} title="Windows" file={exe} extra={msi}
          what="Vitals OS in its own window, plus a quick panel by the clock for check-in, inbox and chats."
          qr={`${origin}/apps/get#windows`} qrLabel="Scan to open this page on another device"
          steps={[
            "Download Setup (.exe) and open it. If Windows says it protected your PC, choose More info → Run anyway.",
            "It installs for your Windows account in a few seconds, with no administrator needed.",
            `If it asks for your company’s address, enter ${origin}.`,
            "Choose Sign in and approve the code in your browser. Updates then arrive by themselves.",
          ]} />
        <Card id="iphone" icon={Tablet} title="iPhone and iPad"
          what="Add Vitals OS to your Home Screen from Safari. It opens full screen like an app and stays signed in."
          note="Add to Home Screen from Safari · no download needed"
          qr={`${origin}/apps/get#iphone`} qrLabel="Scan with your iPhone camera, then open in Safari"
          steps={[
            `Open ${origin} in Safari (not Chrome) and sign in.`,
            "Tap the Share button (the square with an arrow pointing up) at the bottom of the screen.",
            "Scroll down and tap Add to Home Screen, then Add.",
            "Open Vitals OS from your Home Screen. To get notifications, allow them when Vitals OS asks.",
          ]} />
      </div>
      <p className={css.foot}>Installers come straight from Vitals OS, not an app store. Each one shows its SHA-256 checksum so IT can confirm the file.</p>
    </div>
  );
}
