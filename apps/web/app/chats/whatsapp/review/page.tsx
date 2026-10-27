import { api } from '../../../lib/api';
import { Message, Page, PageHeader } from '../../../ui';
import { ReviewApp, type ReviewItem, type ReviewSet } from './review';
// WA-AUDIO (1112): check the machine transcripts of a test set of imported voice notes. Admins, leadership and the
// colleague the set's task is assigned to; everyone else sees that nothing is assigned to them.
export default async function TranscriptReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
 const q = await searchParams;
 const s = await api<{ sets: ReviewSet[] }>('chats/whatsapp/review');
 if (s.error) return <Message text={s.error} />;
 const sets = s.data!.sets;
 if (!sets.length) return <Message text="No voice-note check is assigned to you. It opens when a review task is assigned to you." />;
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
