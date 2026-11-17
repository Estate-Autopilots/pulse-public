import { api } from '../../../lib/api';
import { AudioLines } from 'lucide-react';
import { Empty, Message, Page, PageHeader, styles } from '../../../ui';
import { ReviewApp, type ReviewItem, type ReviewSet } from './review';
// WA-AUDIO (1112): check the machine transcripts of a test set of imported voice notes. Admins, leadership and the
// colleague the set's task is assigned to; everyone else sees that nothing is assigned to them.
export default async function TranscriptReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 const q = await searchParams;
 const s = await api<{ sets: ReviewSet[] }>('chats/whatsapp/review');
 if (s.error) return <Message text={s.error} />;
 const sets = s.data!.sets;
 // VISUAL-QA (10 Nov 2026): the menu leads here (Chats → Check voice-note transcripts, Data review), so with nothing to
 // check it is a calm empty page with its title and a way back, not "This view is unavailable".
 if (!sets.length) return <Page>
  <PageHeader title="Check voice-note transcripts" back={{ href: '/chats/data', label: 'Data review' }} />
  <section className={styles.panel}><Empty icon={AudioLines} first title="Nothing to check right now"
   text="When voice notes come in with an imported WhatsApp chat, a set of clips to check opens here for the person it is given to."
   action={{ href: '/chats/data', label: 'Back to Data review' }} /></section>
 </Page>;
 const key = q.set && sets.some((x) => x.set === q.set) ? q.set : sets[0].set;
 const r = await api<{ set: string; items: ReviewItem[] }>(`chats/whatsapp/review/${key}`);
 if (r.error) return <Message text={r.status === 404 ? 'This review set is not available to you.' : r.error} />;
 const items = r.data!.items, mine = items.filter((i) => i.mine).length;
 const minutes = Math.round(items.reduce((t, i) => t + (i.durationS ?? 0), 0) / 60);
 return <Page>
  <PageHeader title="Check voice-note transcripts" back={{ href: '/chats', label: 'Chats' }}
   context={[`${items.length} clips · ${minutes} min of audio`, `${mine} checked by you`]} />
  <ReviewApp set={key} items={items} />
 </Page>;
}
