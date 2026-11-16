import Link from 'next/link';
import { FolderOpen } from 'lucide-react';
import { api } from '../../lib/api';
import { Message, Page } from '../../ui';
import { FinanceRefused } from '../page-head';
import { PageHeader } from '../../components/kit';
import { FinanceFrame } from '../nav';
import type { LiveState } from '../types';
import { FirstRunCard } from '../../start/first-run-card';
import { YourCa } from './actions';
import { CaDesk, TwoStepNeeded, type DeskData } from './ca-desk';
import { Registers, type Desk } from './registers';
import css from './desk.module.css';

type Full = Desk & DeskData & { cas?: { id: string; name: string; until: string; salaries: boolean; active: boolean }[] };

/** CA-ACCESS (owner, 8 Nov 2026): Finance → CA check. The CA's month (close steps, bills To verify / Asked / Verified,
 *  one bill's panel with Verified, Ask and the thread) and the downloads; the owner sees the same page with what the
 *  CA checked, and who has CA access. The old registers are one click away (All registers). */
export default async function FinanceDeskPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const synthetic = q.pilot === 'synthetic';
  const [result, me] = await Promise.all([api<Full>('finance/desk' + (synthetic ? '?pilot=synthetic' : '')), api<{ role?: string }>('me')]);
  const d = result.data;
  const accountant = me.data?.role === 'accountant';
  // VISUAL-QA: a refusal says what Finance's other views say (it printed the database's own words, "Finance amount and
  // source grants required"); the menu no longer leads here for someone refused.
  if (!d && !accountant && result.status === 403) return <Page calm><FinanceRefused what="CA check figures" /></Page>;
  if (!d) return <Page calm><PageHeader eyebrow={['Finance']} title="Check the books" lede="Bills and invoices for your CA to verify, the month’s GST, TDS and bank steps, and downloads." />
    {accountant ? <><FirstRunCard /><TwoStepNeeded /></> : <Message text={result.error ?? 'Finance is not open for this account.'} />}</Page>;
  const live = d.accountant ? null : (await api<LiveState>('finance/live')).data;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const registers = q.view === 'registers';
  return <Page calm>
    <FinanceFrame tab="ca" live={live} nav={!d.accountant} private={d.accountant ? 'Every view is recorded' : 'Private to founders and your CA'} />
    {d.accountant ? <FirstRunCard /> : null}
    <div className={css.desk}>
      {synthetic ? <p className={css.foot}><FolderOpen size={14} aria-hidden="true" />Sample data for testing. Nothing here is real. <Link href="/finance/desk">Show the real books</Link></p> : null}
      {registers ? <>
        <p className={css.foot}><Link href={`/finance/desk?${synthetic ? 'pilot=synthetic' : ''}`}>← Back to the month</Link></p>
        <Registers d={d} view={q.r} />
      </> : <>
        <CaDesk data={d} month={q.month} today={today} quarterly={(live?.model?.compliance?.quarters?.length ?? 0) > 0} tools={d.canManage ? <YourCa initial={d.cas ?? []} /> : null} />
        {d.accountant || synthetic || d.records.length ? null : <p className={css.foot}><Link href="/finance/desk?pilot=synthetic">Try it with sample data</Link></p>}
      </>}
    </div>
  </Page>;
}
