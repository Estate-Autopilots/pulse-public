import Link from "next/link";
import { Clock, PlayCircle } from "lucide-react";
import { Page, PageHeader, QueryTabs } from "../ui";
import { PLAYLISTS, TUTORIALS, playlistTutorials, type Tutorial } from "../lib/learn.mjs";
import { mediaFor } from "./files";
import { DoneTick, Progress } from "./progress";
import css from "./learn.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Learn Pulse" };

function Card({ t, video }: { t: Tutorial; video: boolean }) {
  return <Link href={`/learn/${t.id}`} className={css.card}>
    <span className={css.cardTop}><span className={css.who}>{t.who}</span><DoneTick id={t.id} /></span>
    <strong className={css.cardTitle}>{t.title}</strong>
    <span className={css.cardText}>{t.summary}</span>
    <span className={css.meta}><span><Clock size={13} aria-hidden="true" />{t.steps.length} steps · about {t.minutes} min</span>{video ? <span><PlayCircle size={13} aria-hidden="true" />Video</span> : null}</span>
  </Link>;
}

/** XRAY-LINK (owner, 25 Oct 2026): Learn Pulse: short tutorials (steps with a screenshot each, and a video where one was
 *  made) grouped into playlists by topic or by role. Progress is kept per person in this browser. */
export default async function Learn({ searchParams }: { searchParams: Promise<{ by?: string }> }) {
  const by = (await searchParams).by === "role" ? "role" : "topic";
  const video = new Set(TUTORIALS.filter((t) => Object.keys(mediaFor(t.id)?.video ?? {}).length).map((t) => t.id));
  const lists = PLAYLISTS.filter((p) => p.kind === by);
  return <Page>
    <PageHeader title="Learn Pulse" context={["Short tutorials for every part of Pulse", `${TUTORIALS.length} tutorials`]} />
    <div className={css.intro}>
      <p>Each tutorial is a few steps with a picture of the screen, a video where there is one, and a <b>Try it</b> button that opens the real page. Look for <b>How do I…</b> (the <span aria-hidden="true">?</span> at the top) on a page to see the tutorials for it.</p>
      <Progress ids={TUTORIALS.map((t) => t.id)} label="All tutorials" />
    </div>
    <QueryTabs base="/learn" param="by" current={by} label="Group tutorials" items={[{ key: "topic", label: "By topic" }, { key: "role", label: "By role" }]} />
    {lists.map((p) => {
      const items = playlistTutorials(p.id);
      return <section key={p.id} className={css.playlist} aria-labelledby={`pl-${p.id}`}>
        <div className={css.playlistHead}>
          <div><h3 id={`pl-${p.id}`}>{p.title}</h3><p>{p.about}</p></div>
          <Progress ids={items.map((t) => t.id)} label={p.title} />
        </div>
        <div className={css.grid}>{items.map((t) => <Card key={t.id} t={t} video={video.has(t.id)} />)}</div>
      </section>;
    })}
  </Page>;
}
