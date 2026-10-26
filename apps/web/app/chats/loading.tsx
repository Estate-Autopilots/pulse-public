import { Suspense } from 'react';
import { Page } from '../ui';
import { ChatsBoot } from './boot';
import { Skeleton } from './app';
// While the page renders: the chat list (and open conversation) from this browser's cache, or on the very first visit
// the shape of the list. Never the dashboard skeleton.
export default function Loading() {
 return <Page fit><Suspense fallback={<Skeleton/>}><ChatsBoot/></Suspense></Page>;
}
