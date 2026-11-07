import css from './evidence.module.css';

const label = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const sourceUrl = (value: unknown) => {
  try {
    const url = new URL(label(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
};

export function HistoryEvidence({ value }: { value: unknown }) {
  const entries = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  );
  return <details><summary>Source details</summary><div className={css.sources}>
    {entries.length ? entries.map((entry, index) => {
      const href = sourceUrl(entry.url);
      const manual = entry.source === 'manual_hr_history';
      const fields = [
        ['Sheet', label(entry.sheet)],
        ['Row', label(entry.row)],
        ['Method', label(entry.method)],
        ['Columns', Array.isArray(entry.columns) ? entry.columns.map(label).filter(Boolean).join(', ') : ''],
        ['Reason', label(entry.reason)],
      ].filter(([, value]) => value);
      return <div key={index}>
        <strong>{manual ? 'Recorded by HR in Pulse' : 'Imported report'}</strong>
        {fields.length ? <dl className={css.fields}>{fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : null}
        {href ? <a href={href} target="_blank" rel="noopener noreferrer">Open source report</a> : null}
        {!manual && !fields.length && !href ? <p>No source details available.</p> : null}
      </div>;
    }) : <p>No source details available.</p>}
  </div></details>;
}
