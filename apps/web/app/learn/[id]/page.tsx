import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ExternalLink } from "lucide-react";
import { Page, PageHeader, styles } from "../../ui";
import { PLAYLISTS, TUTORIALS, playlistTutorials, stepParts, tutorial } from "../../lib/learn.mjs";
import { CAPTION_LABELS, VIDEO_LABELS, mediaFor } from "../files";
import { DoneButton } from "../progress";
import css from "../learn.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const t = tutorial((await params).id);
  return { title: t ? `${t.title} · Learn Pulse` : "Learn Pulse" };
}

/** A step's words: **Label** is the exact name of a button or field on the screen. */
function Words({ text }: { text: string }) {
  return <>{stepParts(text).map((p, i) => p.ui ? <b key={i} className={css.ui}>{p.text}</b> : <span key={i}>{p.text}</span>)}</>;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** XRAY-LINK: one tutorial: who it is for, the video (where one was made, with captions), numbered steps with a
 *  screenshot each, Try it (the real page), Mark as done and the next tutorial in its playlist. */
export default async function LearnTutorial({ params }: { params: Promise<{ id: string }> }) {
  const t = tutorial((await params).id);
  if (!t) notFound();
  const media = mediaFor(t.id);
  const langs = Object.keys(media?.video ?? {});
  const list = PLAYLISTS.find((p) => p.kind === "topic" && p.items.includes(t.id));
  const inList = list ? playlistTutorials(list.id) : TUTORIALS;
  const next = inList[inList.indexOf(t) + 1];
  const youtube = Object.entries(media?.youtube ?? {}).filter((e): e is [string, string] => !!e[1]);
  return <Page>
    <PageHeader title={t.title} back={{ href: "/learn", label: "Learn Pulse" }} context={[t.who, `${t.steps.length} steps · about ${t.minutes} min`]}
      actions={<><DoneButton id={t.id} /><Link href={t.tryHref} className={`${styles.btn} ${styles.btnPrimary}`}>Try it<ArrowRight size={15} aria-hidden="true" /></Link></>} />
    <p className={css.lead}>{t.summary}</p>
    {media && langs.length ? <section className={css.video} aria-label="Video">
      {langs.map((lang, i) => <details key={lang} open={i === 0} className={css.videoLang}>
        <summary>{langs.length > 1 ? `Video · ${VIDEO_LABELS[lang] ?? lang}` : "Video"}{media.seconds ? ` · ${clock(media.seconds)}` : ""}{media.voice === false ? " · captions, no voice yet" : ""}</summary>
        <video controls preload="metadata" playsInline poster={media.poster ? `/learn/media/${t.id}/${media.poster}` : undefined} src={`/learn/media/${t.id}/${media.video![lang]}`}>
          {Object.entries(media.captions ?? {}).map(([cl, f]) => <track key={cl} kind="captions" srcLang={cl.split("-")[0]} label={CAPTION_LABELS[cl] ?? cl} src={`/learn/media/${t.id}/${f}`} default={cl === (lang === "hi" ? "hi-Latn" : lang)} />)}
        </video>
      </details>)}
      {media.chapters?.length ? <ol className={css.chapters} aria-label="Chapters">{media.chapters.map((c) => <li key={c.at}><span>{clock(c.at)}</span>{c.title}</li>)}</ol> : null}
      {youtube.length ? <p className={css.yt}>{youtube.map(([lang, url]) => <a key={lang} href={url} target="_blank" rel="noreferrer">Watch on YouTube ({VIDEO_LABELS[lang] ?? lang})<ExternalLink size={13} aria-hidden="true" /></a>)}</p> : null}
    </section> : null}
    <ol className={css.steps}>
      {t.steps.map((s, i) => <li key={i} className={css.step}>
        <span className={css.num} aria-hidden="true">{i + 1}</span>
        <div className={css.stepBody}>
          <p><Words text={s.text} /></p>
          {s.note ? <p className={css.note}>{s.note}</p> : null}
          {s.shot ? /* eslint-disable-next-line @next/next/no-img-element -- a small screenshot served by the app itself */
            <img className={css.shot} src={`/learn-shots/${t.id}/${s.shot}.webp`} alt={`Step ${i + 1}: ${stepParts(s.text).map((p) => p.text).join("")}`} width={1280} height={800} loading={i < 2 ? "eager" : "lazy"} /> : null}
        </div>
      </li>)}
    </ol>
    <div className={css.foot}>
      <Link href={t.tryHref} className={`${styles.btn} ${styles.btnPrimary}`}>Try it in Pulse<ArrowRight size={15} aria-hidden="true" /></Link>
      <DoneButton id={t.id} />
      {next ? <Link href={`/learn/${next.id}`} className={styles.btn}>Next: {next.title}</Link> : <Link href="/learn" className={styles.btn}>All tutorials</Link>}
    </div>
    <p className={css.fine}>The pictures and videos use a made-up company (Brightside Studio); your Pulse shows your own work.</p>
  </Page>;
}
