// COMPANY-SEARCH (owner, 8 Nov 2026): "Find companies and people". Every company on Vitals (what it chose to show) and
// the people who turned on "Let people find me". ⌘K opens it with ?q=.
// FIX-SHELL (owner, 10 Nov 2026: "the Find companies UI is bad; redesign it", Codex concept 1): one search panel (what to
// find, then the box), results as a grid of cards, and before anything is typed: the company's own place on Vitals (how
// complete its public profile is, one button to finish it; admins) and what can be searched for.
import { api, getMe } from "../lib/api";
import { Page, PageHeader } from "../ui";
import { DirectorySearch, type OwnCard } from "./search";

export default async function Directory({ searchParams }: { searchParams: Promise<{ q?: string; tab?: string }> }) {
  const p = await searchParams;
  const tab = p.tab === "people" ? "people" : "companies";
  const me = (await getMe()).data;
  const card = me?.role === "admin" ? (await api<{ card: OwnCard["card"] }>("directory/card")).data?.card ?? null : null;
  const own: OwnCard | null = card && me ? { card, name: me.orgName ?? "Your company", handle: me.orgHandle ?? null } : null;
  return <Page>
    <PageHeader title="Find companies" context={["Companies and people on Vitals"]} recent={{ title: "Find companies" }} />
    <DirectorySearch initialQ={(p.q ?? "").slice(0, 120)} initialTab={tab} own={own} />
  </Page>;
}
