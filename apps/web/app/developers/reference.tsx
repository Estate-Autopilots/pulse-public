'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ActionButton } from '@pulse/ui-shell';
import { Panel, styles } from '../ui';
import { operations, prepareRequest, referenceRequest, sendRequest, type Operation, type Reference as Spec } from './model';
import css from './developers.module.css';

export default function Reference() {
  const [doc, setDoc] = useState<Spec>(), [ops, setOps] = useState<Operation[]>([]), [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('Loading the live reference…'), [result, setResult] = useState(''), [busy, setBusy] = useState(false);
  const [params, setParams] = useState('{}'), [query, setQuery] = useState('{}'), [body, setBody] = useState('');
  const [idempotency, setIdempotency] = useState(''), [confirmed, setConfirmed] = useState(false);
  const key = useRef<HTMLInputElement>(null), pending = useRef<AbortController | null>(null);
  const op = ops[selected], write = op && op.method !== 'get';
  function clear() { pending.current?.abort(); if (key.current) key.current.value = ''; setResult(''); setBody(''); setParams('{}'); setQuery('{}'); setIdempotency(''); setConfirmed(false); setBusy(false); }
  async function load() {
    pending.current?.abort(); const controller = pending.current = new AbortController();
    try { const response = await fetch('/api/v1/openapi.json', { ...referenceRequest, signal: controller.signal }); if (!response.ok) throw Error();
      const value = await response.json(); const found = operations(value); if (controller.signal.aborted) return;
      setDoc(value); setOps(found); setSelected(0); setIdempotency(found[0] && found[0].method !== 'get' ? crypto.randomUUID() : ''); setStatus(found.length ? 'Reference ready. Paste an API key to run an operation.' : 'No operations are published yet. Reload after this install’s next API release.');
    } catch { if (!controller.signal.aborted) setStatus('Reference unavailable or disconnected. Check your connection and reload.'); }
  }
  useEffect(() => {
    void load();
    const hide = () => { clear(); setStatus('Private inputs and response cleared. Paste a key to try again.'); };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) hide(); };
    const previousTheme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const offline = () => { hide(); setStatus('Disconnected. Reconnect, reload the reference, and paste your key again.'); };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', restore); window.addEventListener('offline', offline);
    const input = key.current;
    return () => { pending.current?.abort(); if (input) input.value = ''; if (previousTheme) document.documentElement.dataset.theme = previousTheme; else delete document.documentElement.dataset.theme; window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore); window.removeEventListener('offline', offline); };
  }, []);
  async function run(event: FormEvent) {
    event.preventDefault(); setResult('');
    try {
      const request = prepareRequest(op, key.current?.value.trim() ?? '', params, query, body, idempotency, confirmed);
      pending.current?.abort(); const controller = pending.current = new AbortController(); setBusy(true); setStatus('Sending request…');
      try { const response = await sendRequest(request, controller.signal); if (controller.signal.aborted) return;
        setResult(response.text); setStatus(response.status === 401 ? 'Key unknown, malformed, revoked or expired. Create a fresh key in Integrations.' : response.status >= 400 ? 'API error. Check the status, request id and response below.' : 'Request succeeded. The private result stays in this view until cleared.');
      } catch { if (!controller.signal.aborted) setStatus('Request disconnected or unavailable. Writes are not retried automatically; reuse the idempotency key when retrying.'); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    } catch (error) { setStatus(error instanceof SyntaxError ? 'Use valid JSON for parameters, query and body.' : (error as Error).message); }
  }
  return <section id="reference" aria-label="API reference" className={css.reference}>
    <Panel title="Live reference" sub={doc ? `OpenAPI ${doc.openapi} · v${doc.info?.version ?? '1.0'}` : 'Fetching this install’s contract'} tools={<ActionButton variant="secondary" onClick={() => { clear(); setStatus('Loading the live reference…'); void load(); }}>Reload reference</ActionButton>}>
      <p role="status" aria-live="polite">{status}</p>
      {!doc && status.startsWith('Loading') && <div className={css.skeleton} aria-label="Reference loading" />}
      <label className={styles.field}>Operation<select aria-label="Operation" value={selected} disabled={!ops.length || busy} onChange={e => { pending.current?.abort(); setSelected(Number(e.target.value)); setStatus('Paste an API key to run this operation.'); setResult(''); setParams('{}'); setQuery('{}'); setBody(''); setConfirmed(false); setIdempotency(crypto.randomUUID()); }}>
        {ops.map((item, index) => <option key={`${item.method} ${item.path}`} value={index}>{item.method.toUpperCase()} {item.path}</option>)}
      </select></label>
      {op && <><h3><code>{op.method.toUpperCase()} {op.path}</code></h3><p>{op.summary}</p>
        <p>{/^\/api\/v1\/(service|catalog)\//.test(op.path) ? 'Legacy service scopes are distinct from area scopes. These paths retain their existing service contract.' : `Required area scope: ${(op.security ?? []).flatMap(item => Object.values(item).flat()).join(', ') || 'See contract'}. The key’s principal and company visibility still apply.`}</p>
        <details><summary>Operation contract</summary><pre>{JSON.stringify(op, null, 2)}</pre></details>
        <form onSubmit={run} className={css.form}>
          <label className={styles.field}>API key<input ref={key} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="psvc_…" onChange={() => { pending.current?.abort(); setBusy(false); setResult(''); }} /></label>
          <p>The pasted key is sent only to this origin. Cookies are omitted. It is never saved. Clear it before sharing your screen.</p>
          <label className={styles.field}>Path parameters (JSON)<textarea value={params} onChange={e => setParams(e.target.value)} placeholder={'{"id":"example-id"}'} /></label>
          <label className={styles.field}>Query parameters (JSON string values)<textarea value={query} onChange={e => setQuery(e.target.value)} placeholder={'{"limit":"10"}'} /></label>
          {write && <><label className={styles.field}>Request body (JSON, optional)<textarea value={body} onChange={e => setBody(e.target.value)} /></label>
            <label className={styles.field}>Idempotency key<input value={idempotency} onChange={e => setIdempotency(e.target.value)} required /></label>
            <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I intend to send this write with the pasted key.</label></>}
          <div className={css.actions}><ActionButton type="submit" disabled={busy || op.path.endsWith('/tasks/mine')}>Send {op.method.toUpperCase()} request</ActionButton><ActionButton variant="secondary" onClick={() => { clear(); setStatus('Key, inputs and result cleared.'); }}>Clear private data</ActionButton></div>
        </form></>}
      {result && <pre aria-label="API response" tabIndex={0}>{result}</pre>}
    </Panel>
    <Panel title="Working with v1"><dl><dt>Scopes</dt><dd>Area grants use <code>tasks.read</code> / <code>tasks.write</code>, for example. Legacy <code>catalog.read</code> and <code>quotes.draft.create</code> are separate grants.</dd>
      <dt>Errors</dt><dd>400 invalid input; 401 missing, expired or revoked key; 403 scope or visibility; 404 unavailable; 409 conflict; 429 rate limit. Area errors use problem+json with requestId; legacy errors retain their own shape.</dd>
      <dt>Paging & limits</dt><dd>Use only the query parameters in the operation contract. On legacy lists, pass <code>{'{"limit":"10"}'}</code>, then the returned <code>nextCursor</code> as <code>cursor</code>. Honour Retry-After and the returned RateLimit headers. Service budget: 120 calls/minute per API process; phone lookup: 30/minute per key.</dd>
      <dt>Writes</dt><dd>Keep one Idempotency-Key for retries of the same request, for example <code>example-write-001</code>. Changed input needs a new key. Check each operation’s contract; legacy operations retain their existing idempotency rules.</dd></dl></Panel>
  </section>;
}
