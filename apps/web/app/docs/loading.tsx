import css from "./drive/drive.module.css";

/** DOCS-DRIVE: while a folder opens, the page keeps its shape (the tree, the top bar, tiles and cards) instead of going blank. */
export default function Loading() {
  const block = (h: number, w: string | number = "100%") => <div className={css.skel} style={{ height: h, width: w }} />;
  return <div className={css.shell} aria-busy="true" aria-label="Opening docs">
    <div className={css.side} style={{ gap: 8 }}>{Array.from({ length: 9 }, (_, i) => <div key={i}>{block(28, `${60 + ((i * 17) % 35)}%`)}</div>)}</div>
    <div className={css.main}>
      <div className={css.top}>{block(44, "50%")}{block(44, 96)}</div>
      {block(32, 220)}
      <div className={css.folders}>{Array.from({ length: 4 }, (_, i) => <div key={i}>{block(68)}</div>)}</div>
      <div className={css.cards}>{Array.from({ length: 6 }, (_, i) => <div key={i}>{block(172)}</div>)}</div>
    </div>
  </div>;
}
