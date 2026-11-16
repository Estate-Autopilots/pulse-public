import css from "../drive/drive.module.css";

/** DOCS-DRIVE: while a doc opens: its title and a page of lines (not the folder view's skeleton). */
export default function Loading() {
  const block = (h: number, w: string | number = "100%") => <div className={css.skel} style={{ height: h, width: w }} />;
  return <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 900, margin: "0 auto", width: "100%" }} aria-busy="true" aria-label="Opening the doc">
    {block(18, 220)}{block(40, "60%")}{block(16, 260)}
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>{Array.from({ length: 10 }, (_, i) => <div key={i}>{block(14, `${70 + ((i * 13) % 30)}%`)}</div>)}</div>
  </div>;
}
