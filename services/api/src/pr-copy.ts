// PR-STUDIO (owner, 6 Nov 2026): the words. Pure functions that turn Story lines into chapters, briefs and a creative pack
// (headline, a WhatsApp-formatted copy, a long post and image specs), so the screens, API v1 / MCP and the tests say the
// same thing. Plain copywriting rules, no model: lead with the result, be specific (numbers and names of things), show
// momentum (what moved since last time), keep lines short, one clear ask at the end. An AI employee may rewrite any of it
// through API v1 (pr area); a person edits it on the screen. Nothing here sends anything.

export const KINDS = ['release', 'feature', 'bug', 'task', 'goal', 'meeting', 'note'] as const;
export type Kind = typeof KINDS[number];
export const TONES = ['warm', 'formal', 'bold', 'plain'] as const;
export type Tone = typeof TONES[number];
export const CHANNELS = ['whatsapp', 'telegram', 'email', 'linkedin', 'x'] as const;
export type Channel = typeof CHANNELS[number];
export const RATIOS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type Ratio = typeof RATIOS[number];
export const BRIEF_KINDS = ['morning', 'evening', 'update', 'weekly'] as const;
export type BriefKind = typeof BRIEF_KINDS[number];

export type Entry = { id: string; happenedOn: string; kind: Kind; title: string; body: string };
export type Audience = { id: string; name: string; tone: Tone; channel: Channel; ratio: Ratio };
export type ImageSpec = { template: 'headline' | 'list' | 'number'; ratio: Ratio; kicker: string; title: string; lines: string[]; big: string | null };
export type Pack = { headline: string; copy: string; longPost: string; images: ImageSpec[] };

/** Weight: what a reader cares about first. Releases and features lead, then goals, bugs, meetings, tasks, notes. */
const WEIGHT: Record<Kind, number> = { release: 0, feature: 1, goal: 2, bug: 3, meeting: 4, task: 5, note: 6 };
const MARK: Record<Kind, string> = { release: '🚀', feature: '✨', goal: '🎯', bug: '🛠️', meeting: '🤝', task: '✅', note: '📝' };
const NOUN: Record<Kind, [string, string]> = { release: ['release', 'releases'], feature: ['new feature', 'new features'], goal: ['goal moved', 'goals moved'],
  bug: ['bug fixed', 'bugs fixed'], meeting: ['meeting', 'meetings'], task: ['task line', 'task lines'], note: ['note', 'notes'] };

export const ranked = (entries: Entry[]) => [...entries].sort((a, b) => WEIGHT[a.kind] - WEIGHT[b.kind] || b.happenedOn.localeCompare(a.happenedOn));

/** "Tasks done" lines carry their count ("12 tasks done in …"): the real number of tasks, not of lines. */
export function taskCount(entries: Entry[]) {
  return entries.filter(e => e.kind === 'task').reduce((n, e) => n + (Number(/^(\d+) tasks? done/.exec(e.title)?.[1]) || 1), 0);
}

/** The counts that make a headline specific: "2 releases, 5 bugs fixed and 31 tasks done". */
export function tally(entries: Entry[]): string {
  const parts: string[] = [];
  for (const k of KINDS) {
    if (k === 'note') continue;
    if (k === 'task') { const n = taskCount(entries); if (n) parts.push(`${n} ${n === 1 ? 'task' : 'tasks'} done`); continue; }
    const n = entries.filter(e => e.kind === k).length;
    if (n) parts.push(`${n} ${NOUN[k][n === 1 ? 0 : 1]}`);
  }
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ------------------------------------------------------------------------------------------------ chapters (the book)
const DAY_MS = 86400000;
const utc = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (t: Date) => t.toISOString().slice(0, 10);
/** Monday of the day's week (YYYY-MM-DD). */
export const weekOf = (d: string) => { const t = utc(d); return iso(new Date(t.getTime() - (((t.getUTCDay() + 6) % 7) * DAY_MS))); };
export const monthOf = (d: string) => `${d.slice(0, 7)}-01`;
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const SHORT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dayWords = (d: string) => SHORT.format(utc(d));
export const monthWords = (d: string) => MONTH.format(utc(d));

export type ChapterEdit = { period: 'week' | 'month'; startsOn: string; title: string; summary: string };
export type Week = { startsOn: string; title: string; summary: string; edited: boolean; days: { day: string; entries: Entry[] }[] };
export type Month = { startsOn: string; title: string; summary: string; edited: boolean; weeks: Week[] };

/** The Story as a book: months, then weeks (Monday first), then days, newest first. A chapter's title and summary are
 *  the edited ones when someone wrote them, otherwise worked out from what happened. */
export function chapters(entries: Entry[], edits: ChapterEdit[] = []): Month[] {
  const edit = (period: 'week' | 'month', startsOn: string) => edits.find(e => e.period === period && e.startsOn === startsOn);
  const months = new Map<string, Map<string, Map<string, Entry[]>>>();
  for (const e of [...entries].sort((a, b) => b.happenedOn.localeCompare(a.happenedOn))) {
    const m = monthOf(e.happenedOn), w = weekOf(e.happenedOn);
    if (!months.has(m)) months.set(m, new Map());
    const weeks = months.get(m)!;
    if (!weeks.has(w)) weeks.set(w, new Map());
    const days = weeks.get(w)!;
    if (!days.has(e.happenedOn)) days.set(e.happenedOn, []);
    days.get(e.happenedOn)!.push(e);
  }
  return [...months.entries()].map(([m, weeks]) => {
    const all = [...weeks.values()].flatMap(d => [...d.values()].flat());
    const me = edit('month', m);
    return { startsOn: m, title: me?.title || monthWords(m), summary: me?.summary || autoSummary(all), edited: !!me,
      weeks: [...weeks.entries()].map(([w, days]) => {
        const list = [...days.values()].flat(), we = edit('week', w);
        return { startsOn: w, title: we?.title || `Week of ${dayWords(w)}`, summary: we?.summary || autoSummary(list), edited: !!we,
          days: [...days.entries()].map(([day, es]) => ({ day, entries: ranked(es) })) };
      }) };
  });
}

/** One line on a chapter: the tally, then the biggest thing by name. */
export function autoSummary(entries: Entry[]): string {
  if (!entries.length) return 'A quiet stretch: nothing recorded yet.';
  const top = ranked(entries)[0];
  return `${cap(tally(entries))}. The headline: ${top.title}.`;
}
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
const clip = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
const firstLine = (s: string) => s.split('\n').map(x => x.replace(/^[-•*]\s*/, '').trim()).find(Boolean) ?? '';

// ------------------------------------------------------------------------------------------------ briefs
export type BriefIn = { kind: BriefKind; day: string; company: string; entries: Entry[]; dueToday?: number; overdue?: number; untold?: number; streak?: number };
/** A brief: title and body (plain text with WhatsApp bold), from the Story lines of its window. */
export function composeBrief(b: BriefIn): { title: string; body: string } {
  const list = ranked(b.entries), t = tally(list);
  const when = dayWords(b.day);
  const title = b.kind === 'morning' ? `Good morning: ${b.company}, ${when}` : b.kind === 'evening' ? `Today at ${b.company}, ${when}`
    : b.kind === 'weekly' ? `${b.company}: the week of ${dayWords(weekOf(b.day))}` : `Update from ${b.company}`;
  const lines: string[] = [];
  if (b.kind === 'morning') {
    lines.push(list.length ? `*Since yesterday:* ${t}.` : '*Since yesterday:* nothing recorded yet. A good day to tell people what is in progress.');
    if (b.dueToday || b.overdue) lines.push(`*Today:* ${b.dueToday ?? 0} due today${b.overdue ? `, ${b.overdue} overdue` : ''}.`);
  } else if (b.kind === 'evening') {
    lines.push(list.length ? `*Done today:* ${t}.` : '*Done today:* nothing recorded. Add a note so the day does not go blank.');
  } else {
    lines.push(list.length ? `*What moved:* ${t}.` : 'Nothing new since the last brief.');
  }
  if (list.length) {
    lines.push('');
    for (const e of list.slice(0, 8)) lines.push(`${MARK[e.kind]} ${clip(e.title, 140)}${e.kind === 'task' || !e.body ? '' : ` — ${clip(firstLine(e.body), 120)}`}`);
    if (list.length > 8) lines.push(`…and ${list.length - 8} more in the Story.`);
  }
  const foot: string[] = [];
  if (b.untold) foot.push(`${b.untold} ${b.untold === 1 ? 'thing is' : 'things are'} done but not yet told`);
  if (b.streak) foot.push(`${b.streak} ${b.streak === 1 ? 'day' : 'days'} told in a row`);
  if (foot.length) lines.push('', `_${cap(foot.join(' · '))}._`);
  return { title: clip(title, 160), body: clip(lines.join('\n'), 8000) };
}

// ------------------------------------------------------------------------------------------------ the creative pack
const HOOK: Record<Tone, (n: number, t: string) => string> = {
  warm: (n, t) => n > 1 ? `Here is what moved — ${t} 👇` : 'A quick one worth sharing 👇',
  formal: (_n, t) => `Progress update: ${t}.`,
  bold: (n) => n > 1 ? `We kept shipping. ${n} wins, no pause. 🚀` : 'Shipped. 🚀',
  plain: (_n, t) => `What's new: ${t}.`,
};
const ASK: Record<Channel, Record<Tone, string>> = {
  whatsapp: { warm: 'Try it and reply here with what you think 🙏', formal: 'Please reply with any feedback.', bold: 'Go try it. Tell us what breaks. 💥', plain: 'Feedback welcome.' },
  telegram: { warm: 'Try it and reply here with what you think 🙏', formal: 'Please reply with any feedback.', bold: 'Go try it. Tell us what breaks. 💥', plain: 'Feedback welcome.' },
  email: { warm: 'Hit reply and tell us what you would like next.', formal: 'Reply to this e-mail with any questions.', bold: 'Reply with what you want next. We read every one.', plain: 'Reply with feedback.' },
  linkedin: { warm: 'What would you build next? Tell me in the comments.', formal: 'Thoughts and questions welcome in the comments.', bold: 'Building in public. Follow along.', plain: 'Comments welcome.' },
  x: { warm: 'What should we ship next?', formal: 'Questions welcome.', bold: 'More soon. 🚀', plain: 'More soon.' },
};

/** The headline: a release by name first; otherwise the biggest thing, carried by the count when there are several. */
export function headline(entries: Entry[], company: string): string {
  const list = ranked(entries);
  if (!list.length) return `${company}: still building`;
  const top = list[0], n = list.length;
  if (top.kind === 'release') return clip(`${top.title} is live`, 160);
  if (top.kind === 'feature') return clip(n > 1 ? `New: ${top.title} (+${n - 1} more)` : `New: ${top.title}`, 160);
  if (n === 1) return clip(top.title, 160);
  return clip(`${cap(tally(list))}`, 160);
}

/** A pack for one audience: WhatsApp/Telegram copy uses *bold* and _italic_; the long post is for LinkedIn or e-mail. */
export function composePack(entries: Entry[], audience: Pick<Audience, 'tone' | 'channel' | 'ratio' | 'name'>, company: string): Pack {
  const list = ranked(entries), t = tally(list), head = headline(list, company);
  const top = list.slice(0, 6);
  const bullets = top.map(e => `${MARK[e.kind]} *${clip(e.title, 110)}*${e.body && e.kind !== 'task' ? `\n   ${clip(firstLine(e.body), 140)}` : ''}`);
  const more = list.length > top.length ? `\n…and ${list.length - top.length} more.` : '';
  const copy = clip([`*${head}*`, '', HOOK[audience.tone](list.length, t || 'progress'), '', ...bullets, more, '', ASK[audience.channel][audience.tone], '', `— ${company}`]
    .filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').trim(), 4000);
  const lp: string[] = [];
  lp.push(/[.!?]$/.test(head) ? head : `${head}.`, '');
  lp.push(list.length > 1 ? `The days don't go blank when you write them down. Here is what ${company} got done${t ? ` — ${t}` : ''}:` : `A small win from ${company}, but it counts:`);
  lp.push('');
  for (const e of top) lp.push(`→ ${clip(e.title, 140)}${e.body && e.kind !== 'task' ? `: ${clip(firstLine(e.body), 160)}` : ''}`);
  if (more) lp.push(more.trim());
  lp.push('', 'Why it matters: every one of these removes a small friction for the people who use it. Small, steady releases beat a big launch that never comes.');
  lp.push('', ASK.linkedin[audience.tone], '', '#buildinpublic #product #startups');
  const longPost = clip(lp.join('\n'), 8000);
  const kicker = list.some(e => e.kind === 'release') ? 'Release' : list.length > 1 ? 'Progress' : 'Update';
  const images: ImageSpec[] = [{ template: 'headline', ratio: audience.ratio, kicker, title: head, lines: top.slice(0, 3).map(e => clip(e.title, 70)), big: null }];
  if (top.length >= 3) images.push({ template: 'list', ratio: audience.ratio, kicker: 'What moved', title: clip(t ? cap(t) : head, 90), lines: top.slice(0, 5).map(e => clip(e.title, 60)), big: null });
  const n = taskCount(list) || list.length;
  if (n >= 5) images.push({ template: 'number', ratio: audience.ratio, kicker: 'Momentum', title: taskCount(list) ? 'tasks done' : 'things shipped', lines: [company], big: String(n) });
  return { headline: head, copy, longPost, images };
}

/** Consecutive days told (a draft posted), counting back from today or, when today has none yet, from yesterday. */
export function streak(toldDays: string[], today: string): number {
  const set = new Set(toldDays);
  let d = set.has(today) ? today : iso(new Date(utc(today).getTime() - DAY_MS)), n = 0;
  while (set.has(d)) { n++; d = iso(new Date(utc(d).getTime() - DAY_MS)); }
  return n;
}

/** Links that open the app with the text in (nothing is sent: the person presses send). */
export function shareLinks(text: string, subject: string) {
  const t = encodeURIComponent(text);
  return { whatsapp: `https://wa.me/?text=${t}`, telegram: `https://t.me/share/url?url=&text=${t}`,
    email: `mailto:?subject=${encodeURIComponent(subject)}&body=${t}`, linkedin: 'https://www.linkedin.com/feed/?shareActive=true', x: `https://x.com/intent/post?text=${encodeURIComponent(text.slice(0, 270))}` };
}

/** PR agents: AI employee templates with the tools they need (the pr area plus the work they read). */
export const PR_AGENTS = [
  { key: 'pr_manager', name: 'PR Manager', title: 'PR manager', lane: 'thinking',
    duty: 'Keeps the Story complete every day, writes the morning and evening briefs, and makes sure nothing done goes untold.' },
  { key: 'creative_strategist', name: 'Creative Strategist', title: 'Creative strategist', lane: 'thinking',
    duty: 'Turns updates into headlines, copy and images for each audience, using the brand templates.' },
  { key: 'project_coordinator', name: 'Project Coordinator', title: 'Project coordinator', lane: 'quick',
    duty: 'Writes features landed, meetings and decisions into the Story, and links them to projects and goals.' },
  { key: 'social_media_manager', name: 'Social Media Manager', title: 'Social media manager', lane: 'quick',
    duty: 'Plans the content calendar for each audience and keeps one post a day ready to copy.' },
] as const;
