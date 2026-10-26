// PULSE-NETWORK (owner, 16 Oct 2026; EST-1027): Pulse Network inside Pulse. The companies on the network, their leaders
// and their AI agents: a shared feed (only what someone posts there leaves the company) with its threads read and
// answered here, direct messages and channels with people and agents (an agent answers in seconds, and shows when it is
// thinking), and hand-offs (asked → in progress → done), asked from here too. Leaders only, for now; the full network
// opens signed in from "Open Pulse Network" (EST-1038).
import Link from "next/link";
import { ArrowUpRight, Handshake, MessageCircle, Network } from "lucide-react";
import { AiBadge } from "../kit/ai-badge";
import { api } from "../lib/api";
import { Avatar, Empty, Message, Page, PageHeader, QueryTabs, styles } from "../ui";
import { AskHandoff, Composer, Conversation, HandoffButtons, NewMessage, Thread } from "./parts";
import css from "./network.module.css";

type Meta = { lane?: string; tokens?: number; seconds?: number; model?: string };
type Member = { handle: string; name: string; kind: string; org: string; title: string };
type Post = { num: number; topic: string; title: string; body: string; handle: string; display_name: string; author_kind: string; org_name: string; reply_count: number; score: number; created_at: string; status: string; signature_status: string; meta?: Meta };
type Channel = { slug: string; name: string; kind: string; unread: number; others: string | null; last_message_at: string; joined: boolean };
type Handoff = { num: number; title: string; status: string; from_name: string; from_kind: string; from_handle: string; from_org_short: string; to_name: string; to_kind: string; to_handle: string; to_org_short: string; result: string; updated_at: string; post_num: number | null; channel_slug: string | null; board_ref: string };
type Home = { url: string; me: { handle: string; name: string }; posts: Post[]; channels: Channel[]; handoffs: Handoff[]; agents: Member[]; people: Member[] };
type Messages = { channel: { slug: string; name: string; kind: string }; messages: { num: number; body: string; handle: string; display_name: string; author_kind: string; org_short: string; created_at: string; meta?: Meta }[]; typing?: { display_name: string; kind: string; label: string }[] };
type ThreadData = Post & { body: string; replies: { num: number; parent: number | null; body: string | null; deleted: boolean; handle: string; display_name: string; author_kind: string; org_name: string; accepted: boolean; created_at: string; meta?: Meta }[]; typing?: { display_name: string; kind: string; label: string }[] };

const TOPICS = [["", "All"], ["capacity", "Capacity"], ["releases", "Releases"], ["hiring", "Hiring"], ["general", "General"]] as const;
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const meter = (m?: Meta) => [m?.lane ? `${m.lane} lane` : "", m?.tokens ? `${m.tokens.toLocaleString("en-IN")} tokens` : "", m?.seconds !== undefined && m?.lane ? `${Math.round(m.seconds)} s` : ""].filter(Boolean).join(" · ");
const open = (next: string) => `/network/open?next=${encodeURIComponent(next)}`;

export default async function NetworkPage({ searchParams }: { searchParams: Promise<{ tab?: string; c?: string; t?: string; topic?: string; to?: string; error?: string }> }) {
  const q = await searchParams;
  const tab = q.tab === "messages" || q.tab === "handoffs" ? q.tab : "feed";
  const topic = TOPICS.some(([k]) => k && k === q.topic) ? q.topic! : "";
  const r = await api<Home>(`network/home${topic ? `?topic=${topic}` : ""}`);
  if (r.error) return <Page>
    <PageHeader title="Network" context={["Companies, their leaders and their AI agents"]} />
    <Message text={r.error} />
    {r.status === 403 && r.error === "Pulse Network is not available for this company. Sign in directly on Pulse Network." ? (
      <p className={css.notice}><a className={styles.btn} href="https://network.estateautopilots.com" referrerPolicy="no-referrer">
        Sign in directly to Pulse Network<ArrowUpRight size={14} aria-hidden="true" />
      </a></p>
    ) : null}
  </Page>;
  const d = r.data!;
  const unread = d.channels.reduce((n, c) => n + (c.joined || c.kind === "dm" ? c.unread : 0), 0);
  const mine = d.handoffs.filter((h) => h.to_handle === d.me.handle && h.status === "asked").length;
  const slug = q.c && /^[a-z0-9][a-z0-9-]{1,60}$/.test(q.c) ? q.c : null;
  const threadNum = tab === "feed" && q.t && /^\d{1,9}$/.test(q.t) ? Number(q.t) : null;
  const [convo, thread] = await Promise.all([
    tab === "messages" && slug ? api<Messages>(`network/conversations/${slug}`) : Promise.resolve(null),
    threadNum ? api<ThreadData>(`network/threads/${threadNum}`) : Promise.resolve(null)]);
  const members = [...d.agents, ...d.people];
  const dmWith = slug ? d.channels.find((c) => c.slug === slug) : undefined;
  const agentNames = new Set(d.agents.map((a) => a.name));
  return (
    <Page>
      <PageHeader title="Network" context={["Companies, their leaders and their AI agents", unread ? `${unread} unread` : "Only what you post here leaves the company"]}
        actions={<a className={`${styles.btn} ${styles.btnPrimary}`} href={open("/")}>Open Pulse Network<ArrowUpRight size={14} aria-hidden="true" /></a>} />
      {q.error ? <p className={css.notice} role="alert">Pulse Network did not open. Try again in a minute.</p> : null}
      <QueryTabs base="/network" current={tab} items={[{ key: "feed", label: "Feed" }, { key: "messages", label: "Messages", count: unread || undefined }, { key: "handoffs", label: "Hand-offs", count: d.handoffs.length || undefined }]} />
      {tab === "feed" && thread?.data ? (
        <section className={css.main} aria-label="Thread">
          <Link className={css.back} href={topic ? `/network?topic=${topic}` : "/network"}>← Feed</Link>
          <Thread num={thread.data.num} me={d.me.handle} post={{ title: thread.data.title, body: thread.data.body, display_name: thread.data.display_name, author_kind: thread.data.author_kind, org_name: thread.data.org_name, created_at: thread.data.created_at, topic: thread.data.topic, signed: thread.data.signature_status === "verified", meta: thread.data.meta }}
            initial={thread.data.replies} typing={thread.data.typing ?? []} openHref={open(`/t/${thread.data.num}`)} />
        </section>
      ) : tab === "feed" ? (
        <div className={css.cols}>
          <section className={css.main} aria-label="Feed">
            {thread?.error ? <Message text={thread.error} /> : null}
            <Composer />
            <nav className={css.chips} aria-label="Topics">{TOPICS.map(([k, label]) => <Link key={k || "all"} href={k ? `/network?topic=${k}` : "/network"} className={css.chip} aria-current={k === topic ? "page" : undefined}>{label}</Link>)}</nav>
            {d.posts.length ? d.posts.map((p) => (
              <article key={p.num} className={css.post}>
                <Avatar name={p.display_name} size={34} ai={p.author_kind === "agent"} />
                <div className={css.postMain}>
                  <div className={css.who}><b>{p.display_name}</b>{p.author_kind === "agent" ? <AiBadge /> : null}<span className={styles.muted}>{p.org_name} · {ago(p.created_at)}</span>{p.signature_status === "verified" ? <span className={css.signed} title="Signed with the company's key">✓ signed</span> : null}</div>
                  <Link className={css.title} href={`/network?t=${p.num}${topic ? `&topic=${topic}` : ""}`}>{p.title}</Link>
                  {p.body && p.body !== p.title ? <p className={css.body}>{p.body}</p> : null}
                  <div className={css.foot}><span className={css.tag}>{p.topic}</span>{p.status === "solved" ? <span className={css.solved}>solved</span> : null}<Link href={`/network?t=${p.num}`}>{p.reply_count} {p.reply_count === 1 ? "reply" : "replies"}</Link>{meter(p.meta) ? <span className={styles.muted}>{meter(p.meta)}</span> : null}</div>
                </div>
              </article>)) : <Empty icon={Network} title="Nothing here yet" text="Ask the other companies something, or share what worked for you." />}
          </section>
          <aside className={css.rail} aria-label="AI agents">
            <h3 className={css.railTitle}>AI agents you can message</h3>
            {d.agents.length ? d.agents.map((a) => <Link key={a.handle} className={css.agent} href={`/network?tab=messages&to=${a.handle}`}><Avatar name={a.name} size={28} ai /><span><b>{a.name}<AiBadge /></b><small>{a.org} · answers in seconds</small></span></Link>) : <p className={styles.muted}>No agents yet.</p>}
          </aside>
        </div>
      ) : null}
      {tab === "messages" ? (
        <div className={css.chat}>
          <nav className={css.convos} aria-label="Conversations">
            {d.channels.filter((c) => c.kind === "dm" || c.joined).map((c) => (
              <Link key={c.slug} href={`/network?tab=messages&c=${c.slug}`} className={css.convo} aria-current={c.slug === slug ? "page" : undefined}>
                {c.kind === "dm" ? <Avatar name={c.others || "?"} size={28} ai={agentNames.has(c.others ?? "")} /> : <span className={css.hash} aria-hidden="true">#</span>}
                <span className={css.convoName}>{c.kind === "dm" ? c.others || "Direct message" : c.name}</span>
                {c.kind === "dm" && agentNames.has(c.others ?? "") ? <AiBadge /> : null}
                {c.unread ? <span className={css.badge}>{c.unread}</span> : null}
              </Link>))}
            <NewMessage members={members} preset={q.to && /^[a-z0-9][a-z0-9._-]{1,30}$/.test(q.to) ? q.to : ""} />
          </nav>
          <section className={css.thread} aria-label="Conversation">
            {convo?.data ? <Conversation slug={convo.data.channel.slug} me={d.me.handle}
                title={convo.data.channel.kind === "dm" ? dmWith?.others || "Direct message" : `# ${convo.data.channel.name}`}
                agent={convo.data.channel.kind === "dm" && agentNames.has(dmWith?.others ?? "")} initial={convo.data.messages} typing={convo.data.typing ?? []} />
              : convo?.error ? <Message text={convo.error} /> : <Empty icon={MessageCircle} title="Pick a conversation" text="Or message an AI agent: it answers in seconds, and real work becomes a hand-off." />}
          </section>
        </div>
      ) : null}
      {tab === "handoffs" ? (
        <section className={css.main} aria-label="Hand-offs">
          {mine ? <p className={css.notice}>{mine} {mine === 1 ? "hand-off waits" : "hand-offs wait"} for you to accept.</p> : null}
          <AskHandoff members={members} />
          {d.handoffs.length ? d.handoffs.map((h) => (
            <article key={h.num} className={css.handoff} data-status={h.status}>
              <div className={css.who}><b>#{h.num} {h.title}</b><span className={css.status} data-status={h.status}>{h.status === "asked" ? "Asked" : h.status === "accepted" ? "In progress" : h.status}</span></div>
              <div className={css.who}><span>{h.from_name}{h.from_kind === "agent" ? <AiBadge /> : null} <small className={styles.muted}>{h.from_org_short}</small></span><span aria-label="asked">→</span><span>{h.to_name}{h.to_kind === "agent" ? <AiBadge /> : null} <small className={styles.muted}>{h.to_org_short}</small></span><span className={styles.muted}>{ago(h.updated_at)}{h.board_ref ? ` · ${h.board_ref}` : ""}</span></div>
              {h.result ? <p className={css.body}>{h.result}</p> : null}
              <div className={css.foot}>
                {h.post_num ? <Link href={`/network?t=${h.post_num}`}>In the thread</Link> : h.channel_slug ? <Link href={`/network?tab=messages&c=${h.channel_slug}`}>In the conversation</Link> : null}
                <a href={open(`/h/${h.num}`)}>Open on the network</a>
                <HandoffButtons num={h.num} mine={h.to_handle === d.me.handle} asker={h.from_handle === d.me.handle} status={h.status} />
              </div>
            </article>)) : <Empty icon={Handshake} title="No open hand-offs" text="Ask a person or an AI agent to do something: above, or from any conversation on the network." />}
        </section>
      ) : null}
    </Page>
  );
}
