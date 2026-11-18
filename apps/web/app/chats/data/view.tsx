"use client";
// FIX-CHAT-AI's Data review, drawn on the client. VISUAL-QA (10 Nov 2026): the page passed lucide icon components to
// the game kit's GameCard (a client component) from the server, which React refuses ("Functions cannot be passed
// directly to Client Components"), so /chats/data showed "This view could not load". The page now hands over plain
// flags and the icons stay on this side.
import { AudioLines, FileClock, History, Lightbulb, Link2, Sparkles, type LucideIcon } from "lucide-react";
import { GameCard, GamePage, ListRow, ListRows, PageHeader } from "../../kit/game";

type Row = { href: string; icon: LucideIcon; title: string; sub: string };

export function DataReviewView({ leads, canImport }: { leads: boolean; canImport: boolean }) {
  const found: Row[] = leads ? [
    { href: "/chats/whatsapp/signals", icon: Sparkles, title: "WhatsApp signals", sub: "Complaints, payment asks, churn risk and upsell chances found in the groups" },
    { href: "/insights", icon: Lightbulb, title: "Client operations", sub: "How clients are served, who waits, what they ask most" },
  ] : [];
  const check: Row[] = [
    { href: "/chats/whatsapp/review", icon: AudioLines, title: "Check voice-note transcripts", sub: "Listen to a clip and fix what the machine heard" },
    { href: "/chats/groups?tab=review", icon: Link2, title: "Imported groups to review", sub: "Say which client or project each imported group belongs to" },
  ];
  const imports: Row[] = [
    { href: "/chats/whatsapp", icon: FileClock, title: "Groups from WhatsApp", sub: "Every group moved in from WhatsApp, with its history" },
    ...(canImport ? [{ href: "/chats/import", icon: History, title: "Import WhatsApp history", sub: "Bring in an exported WhatsApp chat" }] : []),
  ];
  const list = (rows: Row[]) => <ListRows>{rows.map((r) => <li key={r.href}><ListRow href={r.href} lead={<r.icon size={18} />} title={r.title} sub={r.sub} /></li>)}</ListRows>;
  return <GamePage label="Data review">
    <PageHeader title="Data review" subtitle="What Pulse found in your WhatsApp history and imports. Check it here, so your chats stay clean." />
    {found.length ? <GameCard title="Found in your chats" icon={Sparkles}>{list(found)}</GameCard> : null}
    <GameCard title="Check and fix" icon={AudioLines}>{list(check)}</GameCard>
    <GameCard title="Imports" icon={History}>{list(imports)}</GameCard>
  </GamePage>;
}
