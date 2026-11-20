'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { notify } from '@pulse/ui-shell';
import { post } from '../records';
import { styles } from '../ui';
import { SelectField } from '../kit/select-field';
import css from './numbers.module.css';

/** FINANCE-TRUTH: leadership names which Cash book account takes clients' GST; everyone else reads which one it is. */
export function GstAccountPicker({ accounts, current, canSet }: { accounts: string[]; current: string | null; canSet: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? ''), [busy, setBusy] = useState(false);
  if (!canSet) return <p className={css.quiet}>{current ? `GST account: ${current}. Leadership changes it.` : 'No GST account is named yet: leadership names it here, so GST paid there is told apart.'}</p>;
  return <form className={css.picker} onSubmit={async (e) => {
    e.preventDefault(); setBusy(true);
    try { await post('finance/numbers/gst-account', { account: value || null }); notify({ id: 'fin-gst-account', tone: 'success', title: value ? `${value} is the GST account` : 'No GST account named', timeout: 3500 }); router.refresh(); }
    catch (err) { notify({ id: 'fin-gst-account', tone: 'error', title: 'Not saved', message: err instanceof Error ? err.message : 'Could not save' }); }
    finally { setBusy(false); }
  }}>
    <label className={styles.field}>GST is paid into
      <SelectField value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">No separate GST account</option>
        {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
      </SelectField>
    </label>
    <button type="submit" className={styles.btn} disabled={busy || value === (current ?? '')}>Save</button>
    <small>Accounts come from the Cash book. <Link href="/finance?tab=entries">Add an account</Link></small>
  </form>;
}
