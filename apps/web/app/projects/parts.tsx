import Link from "next/link";
import { FileText, Film, Image as ImageIcon } from "lucide-react";
import type { ProjectRow } from "../lib/api";
import { ago, count, plural } from "../lib/format";
import { Badge, styles as ui } from "../ui";
import css from "./projects.module.css";
import { driveUrl, month, stageOf } from "./types";

export function StageBadge({ stage }: { stage: string }) {
  const s = stageOf(stage);
  return <span title={s.rule}><Badge tone={s.tone}><i className={css.dot} data-stage={s.key} aria-hidden="true" />{s.label}</Badge></span>;
}

const fileKind = (mime: string) => mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : "file";
const FILE_ICON = { video: Film, image: ImageIcon, file: FileText };

/** The latest deliveries as file-type tiles. There are no thumbnails in the index, so the tile shows the type and draft/final. */
export function FileTiles({ files, small }: { files: ProjectRow["latest"]; small?: boolean }) {
  if (!files.length) return <div className={css.tilesEmpty} data-small={small ? "" : undefined}>No deliveries indexed yet</div>;
  return (
    <ul className={css.tiles} data-small={small ? "" : undefined} data-tap-ok="" aria-label="Latest deliveries">
      {files.map((f) => {
        const kind = fileKind(f.mime); const Icon = FILE_ICON[kind]; const state = f.kind === "draft" ? "Draft" : "Final";
        return (
          <li key={f.fileId}>
            <a className={css.fileTile} data-kind={kind} href={driveUrl(f.fileId)} target="_blank" rel="noreferrer" title={`${f.fileName} · ${state} ${kind} · open in Drive`}>
              <Icon size={small ? 13 : 15} strokeWidth={1.75} aria-hidden="true" />
              <span>{state}<span className={ui.srOnly}> {kind}: {f.fileName}</span></span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function ClientLink({ id, name }: { id: string | null; name: string | null }) {
  return id && name ? <Link href={`/clients/${id}`} className={css.inlineLink}>{name}</Link> : null;
}

/** One project as a card. The title covers the card; client and file tiles stay separately clickable. */
export function ProjectCard({ p, href, periodName, compact }: { p: ProjectRow; href: string; periodName: string; compact?: boolean }) {
  const place = [p.location, p.segment].filter(Boolean).join(" · ");
  const when = <span className={css.cardWhen}>{p.lastDeliveredAt ? ago(p.lastDeliveredAt) : p.startMonth ? `Starts ${month(p.startMonth)}` : "No deliveries"}</span>;
  // The board's card is two lines, so a column shows a real page of projects; files and the type split live on Cards.
  if (compact) {
    const sub = [p.clientName, place].filter(Boolean).join(" · ") || (p.kind === "internal" ? "Internal project" : "No client linked");
    return (
      <article className={css.card} data-compact="" data-stage={p.stage}>
        <span className={css.titleRow}><Link href={href} className={css.cardLink} title={p.folderName}>{p.title}</Link>{when}</span>
        <span className={css.titleRow}>
          <span className={css.cardSub} title={sub}><ClientLink id={p.clientId} name={p.clientName} />{p.clientName && place ? <span aria-hidden="true"> · </span> : null}{p.clientName ? place : sub}</span>
          <span className={css.statLine} title={`${count(p.count)} ${periodName.toLowerCase()} · ${count(p.total)} all time · ${plural(p.videos, "video")}, ${plural(p.images, "image")}`}>
            <span data-on={p.count ? "" : undefined}><b>{count(p.count)}</b> {periodName.toLowerCase()}</span><span><b>{count(p.total)}</b> all time</span>
          </span>
        </span>
      </article>
    );
  }
  return (
    <article className={css.card} data-stage={p.stage}>
      <div className={css.cardHead}><StageBadge stage={p.stage} />{when}</div>
      <div className={css.cardText}>
        <Link href={href} className={css.cardLink} title={p.folderName}>{p.title}</Link>
        <span className={css.cardSub} title={[p.clientName, place].filter(Boolean).join(" · ") || undefined}>
          <ClientLink id={p.clientId} name={p.clientName} />
          {p.clientName && place ? <span aria-hidden="true"> · </span> : null}
          {place || (p.clientName ? null : <span>{p.kind === "internal" ? "Internal project" : "No client linked"}</span>)}
        </span>
      </div>
      <dl className={css.stats}>
        <div data-on={p.count ? "" : undefined}><dt>{periodName}</dt><dd>{count(p.count)}</dd></div>
        <div><dt>All time</dt><dd>{count(p.total)}</dd></div>
        <div><dt>Videos</dt><dd>{count(p.videos)}</dd></div>
        <div><dt>Images</dt><dd>{count(p.images)}</dd></div>
      </dl>
      <FileTiles files={p.latest} />
      <div className={css.cardFoot}>
        <span>{p.pod ?? `Pod unassigned`}</span>
        {p.startMonth ? <span>Started {month(p.startMonth)}</span> : null}
      </div>
    </article>
  );
}
