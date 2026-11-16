'use client';
import { useState } from 'react';
import { Modal, post } from '../records';
import { styles } from '../ui';
type Invitation = { personId: string; name: string; username: string; recipient: string | null; status: string; reason: string | null; batchId: string };
type Preview = { invitations: Invitation[]; from: string; subject: string; guide: string; linkNotice: string; sendEnabled: boolean };
export function InvitationPreview() {
  const [data, setData] = useState<Preview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function preview() {
    setBusy(true); setError('');
    try {
      await post('admin/invitations/prepare');
      const r = await fetch('/api/v0/admin/invitations', { cache: 'no-store' });
      const body = await r.json(); if (!r.ok) throw new Error(body.error); setData(body);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const ready = data?.invitations.filter(r => r.status === 'prepared') ?? [];
  async function send() {
    if (!ready.length) return;
    setBusy(true); setError('');
    try {
      const result = await post<{ sent: number; failed: number }>('admin/invitations/send', { batchId: ready[0].batchId });
      setError(`${result.sent} sent; ${result.failed} could not be sent.`); setData(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void preview()}>{busy ? 'Preparing invitations…' : 'Preview team invitations'}</button>
    {error ? <p role="status">{error}</p> : null}
    {data ? <Modal title="Preview team invitations" onClose={() => setData(null)} foot={<div className={styles.modalFoot}><button className={styles.btn} onClick={() => setData(null)}>Close</button><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !data.sendEnabled || !ready.length} onClick={() => void send()}>Send {ready.length} invitations</button></div>}>
      <p>From: {data.from}<br/>Subject: {data.subject}</p><p>{data.guide}</p><p>{data.linkNotice}</p>
      {!data.sendEnabled ? <p role="status">Email sending is waiting for verified Google permissions. These invitations are saved for HR/admin to send when enabled.</p> : null}
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Person</th><th>Username</th><th>Delivery email</th><th>Status</th></tr></thead><tbody>{data.invitations.map(row => <tr key={row.personId}><td>{row.name}</td><td>{row.username}</td><td>{row.recipient ?? 'HR needs to confirm'}</td><td>{row.reason ?? row.status}{row.status === 'prepared' ? <small> · Use Account access for private delivery</small> : null}</td></tr>)}</tbody></table></div>
    </Modal> : null}</>;
}
