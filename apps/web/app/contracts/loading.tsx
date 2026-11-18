import css from "./contracts.module.css";

/** CONTRACTS-2: while the agreements load, the page keeps its shape (no jump when the list arrives). */
export default function Loading() {
  return <div className={css.wrap} aria-busy="true" aria-label="Loading agreements">
    <div className={css.skelHead} />
    {[0, 1, 2, 3].map((i) => <div key={i} className={css.skelRow} />)}
  </div>;
}
