import { ShieldCheck } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/kit';

/** UX-FINANCE: one refusal for every Finance view a person may not open: what it is, who may, and the one place to ask. */
export function FinanceRefused({ what = 'Finance figures', text }: { what?: string; text?: string }) {
 return <>
  <PageHeader eyebrow={['Private']} title="Finance" lede="Finance is for leadership and the Finance role." />
  <section aria-label="Finance access required"><EmptyState icon={ShieldCheck} title="Finance access required"
   text={text ?? `${what} are for leadership and the Finance role. Ask an organisation admin to give you the Finance role in Settings → Roles & permissions.`}
   action={{ href: '/settings?tab=roles', label: 'Settings → Roles & permissions' }} secondary={{ href: '/', label: 'Back to Home' }} /></section>
 </>;
}
