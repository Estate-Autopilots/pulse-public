import { Page, Skeleton } from '../../ui';
// The chats list's own loading screen draws conversations; this page is a form.
export default function Loading() {
 return <Page><Skeleton height={28} width={280} /><Skeleton height={180} /><Skeleton height={120} /></Page>;
}
