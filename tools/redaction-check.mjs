#!/usr/bin/env node
// GROUPS-2: measured leak check of the redactor that stands between a group's text and an outside AI engine
// (services/api/src/redact.ts, migration 1113). On the server only: it reads a random sample of imported WhatsApp
// messages of one company, redacts each with its group's names exactly as an AI job's prompt is redacted (the same
// names and word counts 1113's pulse.ai_redaction_names / ai_vocab_refresh give), and checks what is left. Prints
// COUNTS ONLY (nothing of the text) unless --show N is given, which prints N redacted messages (what an engine would
// read) for a person to look over. One READ ONLY transaction with short lock and statement timeouts: it never writes,
// never takes a lock that could hold the API up, and is rolled back.
//   set -a; . /etc/estate-autopilots/db/pulse_dev.env; set +a
//   node tools/redaction-check.mjs [--host groups-demo.localhost | --install] [--sample 2000] [--seed 0.42] [--show 0]
import { createRequire } from "node:module";
const require = createRequire(process.env.PG_FROM ?? new URL("../services/api/package.json", import.meta.url));
const { Client } = require("pg");
const R = await import(process.env.REDACT_MODULE ?? new URL("../services/api/dist/redact.js", import.meta.url).href);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const SAMPLE = Number(arg("sample", 2000)), SHOW = Number(arg("show", 0)), SEED = Number(arg("seed", 0.42)), WORDS = flag("words");
const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) { console.error("Set MIGRATE_DATABASE_URL (the dev database's owner URL)"); process.exit(2); }

const c = new Client({ connectionString: url, application_name: "redaction-check" });
await c.connect();
const q = async (sql, params) => (await c.query(sql, params)).rows;
await c.query("begin transaction read only");
try {
  await c.query("set local lock_timeout = '2s'");
  await c.query("set local statement_timeout = '600s'");
  const org = flag("install") || !arg("host") ? (await q("select pulse.install_org()::text o"))[0].o : (await q("select org_id::text o from pulse.host_org($1)", [arg("host")]))[0]?.o;
  if (!org) throw new Error("No such company");
  await c.query("select set_config('pulse.org_id', $1, true)", [org]);
  // The company's words (as 1113's ai_vocab_refresh counts them).
  const t0 = Date.now();
  const vocab = new Map((await q(`with msgs as (
      select m.channel_id ch, m.body from pulse.chat_message m where m.org_id = $1 and m.removed_at is null and m.kind = 'text' and m.import_ref is null
      union all select m.channel_id, m.body from pulse_priv.chat_import_message m
        join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null where m.org_id = $1 and m.kind = 'text'
      union all select c.channel_id, m.body from pulse_priv.wa_message m join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
        join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null where m.org_id = $1 and m.kind in ('text', 'media') and m.body <> '')
    select lower(w) word, count(*)::int n, count(distinct ch)::int chats, (count(*) filter (where not s))::int mid, (count(*) filter (where not s and w <> lower(w)))::int cap
      from msgs, regexp_matches(body, '(^|[^[:alpha:]\\u0900-\\u097F'']+)([[:alpha:]][[:alpha:]\\u0900-\\u097F'']*)', 'g') x(a),
           lateral (select a[2] w, a[1] = '' or a[1] ~ '[.!?:\\n]' s) y
     where length(w) between 2 and 40 group by lower(w)`, [org])).map((r) => [r.word, [r.n, r.chats, r.mid, r.cap]]));
  const vocabMs = Date.now() - t0;
  // The company's names (as 1113's ai_redaction_names gives them; per group below: its own senders and name).
  const people = (await q(`select p.id, p.display_name from pulse.person p where p.org_id = $1 and btrim(coalesce(p.display_name, '')) <> ''`, [org])).map((r) => [r.id, r.display_name]);
  const members = await q(`select channel_id, array_agg(person_id) ids from pulse.chat_member where org_id = $1 group by 1`, [org]);
  const memberOf = new Map(members.map((r) => [r.channel_id, new Set(r.ids)]));
  const clients = (await q(`select id, display_name, company_name from pulse.client where org_id = $1`, [org])).map((r) => [r.id, r.display_name, r.company_name]);
  const projects = (await q(`select id, name, location from pulse.project where org_id = $1 and deleted_at is null`, [org])).map((r) => [r.id, r.name, r.location]);
  const labels = (await q(`select pa.label l from pulse_priv.wa_participant pa where pa.org_id = $1 and pa.kind not in ('number', 'unknown')
    union select m.author_label from pulse_priv.chat_import_message m where m.org_id = $1`, [org])).map((r) => r.l);
  const places = (await q(`select area pl from pulse.chat_group_info where org_id = $1 and area is not null union select city from pulse.chat_group_info where org_id = $1 and city is not null`, [org])).map((r) => r.pl);
  const parts = new Map((await q(`select c.channel_id, jsonb_agg(jsonb_build_array(pa.id, pa.label, pa.person_id, pa.kind)) ps from pulse_priv.wa_participant pa
    join pulse_priv.wa_chat c on c.org_id = pa.org_id and c.id = pa.chat_id where pa.org_id = $1 group by 1`, [org])).map((r) => [r.channel_id, r.ps]));
  const infos = new Map((await q(`select ch.id, ch.name, g.client_id, g.project_id, g.parsed->>'client' pc, g.parsed->>'project' pp
    from pulse.chat_channel ch left join pulse.chat_group_info g on g.channel_id = ch.id where ch.org_id = $1`, [org])).map((r) => [r.id, r]));
  await c.query("select setseed($1)", [SEED]);
  // The sample: text messages of both kinds of imported history, at least 12 characters, any group.
  const rows = await q(`select * from (
      select c.channel_id ch, m.body from pulse_priv.wa_message m join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
        join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
       where m.org_id = $1 and m.kind = 'text' and length(m.body) >= 12
      union all
      select m.channel_id, m.body from pulse_priv.chat_import_message m
        join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
       where m.org_id = $1 and m.kind = 'text' and length(m.body) >= 12) x order by random() limit $2`, [org, SAMPLE]);
  const byChat = new Map();
  for (const r of rows) { if (!byChat.has(r.ch)) byChat.set(r.ch, []); byChat.get(r.ch).push(r.body); }

  const counts = {}, leaks = { knownName: 0, knownFull: 0, phone: 0, email: 0, longNumber: 0, address: 0 }, leakMsgs = new Set();
  const byKind = { person: 0, participant: 0, label: 0, client: 0, project: 0 };
  let capsLeft = 0, capsMsgs = 0, n = 0, leftOrdinary = 0;
  const leftWords = new Map(), shapes = new Map(); // --words: which name words were left (as an engine would read them) and the shape of long numbers
  const shown = [];
  const ADDR = /\b(flat|plot|road|lane|nagar|society|apartment|residency|building|wing|floor|sector|colony)\b/i;
  for (const [ch, texts] of byChat) {
    const info = infos.get(ch) ?? {}, mem = memberOf.get(ch) ?? new Set();
    const names = { people: people.map(([id, name]) => [id, name, "", mem.has(id)]), clients, projects, participants: parts.get(ch) ?? [], labels,
      group: { client: info.pc ?? null, project: info.pp ?? null }, places };
    const { entities, places: pl } = R.knownNames(names, { clientId: info.client_id, projectId: info.project_id });
    const red = new R.Redactor(entities, { vocab, places: pl });
    const outs = texts.map((t) => red.text(t));
    const ids = R.localIds(red.pending());
    const done = outs.map((o) => red.finish(o, ids));
    for (const [k, v] of Object.entries(red.counts)) counts[k] = (counts[k] ?? 0) + v;
    // A name left behind: a whole name of the company's people, clients, projects or senders, or a word of one (4+
    // letters, not a common word or a place), anywhere in the redacted text.
    const fulls = new Map(), words = new Map(), ordinaryWords = new Set();
    const placeWords = new Set(pl.flatMap((p) => R.fold(p).split(" ")));
    for (const e of entities) {
      const f = R.fold(e.name.replace(/^(mr|mrs|ms|miss|dr|shri|smt)\.?\s+/i, ""));
      if (f.length < 4 || /^number ending/.test(f)) continue;
      const toks = f.split(" ");
      if (toks.length > 1 && !toks.every((t) => R.commonWord(t) || placeWords.has(t))) fulls.set(f, e.kind);
      for (const t of toks) {
        if (t.length < 4 || /^\d+$/.test(t) || R.commonWord(t) || placeWords.has(t)) continue;
        // A word of a client's or project's name the company uses as an ordinary word ("premium") is left on purpose.
        if ((e.kind === "client" || e.kind === "project") && red.ordinary(t)) ordinaryWords.add(t); else words.set(t, e.kind);
      }
    }
    for (const s of done) {
      n++;
      const folded = ` ${R.fold(s)} `;
      let hit = false;
      for (const [f, kind] of fulls) if (folded.includes(` ${f} `)) { leaks.knownFull++; byKind[kind]++; hit = true; }
      for (const w of R.fold(s).split(" ")) if (ordinaryWords.has(w) && !words.has(w)) leftOrdinary++; else if (words.has(w)) { leaks.knownName++; byKind[words.get(w)]++; hit = true; if (WORDS) leftWords.set(`${words.get(w)}:${w}`, (leftWords.get(`${words.get(w)}:${w}`) ?? 0) + 1); }
      const runs = s.replace(/\[[A-Z]+\d+\]/g, " ").match(/(?:\+|00)?\d[\d \-().]{7,20}\d/g) ?? [];
      if (runs.some((x) => /^(?:0{0,2}91|0)?[6-9]\d{9}$|^(?:0{0,2}91|0)[1-9]\d{9}$/.test(x.replace(/\D/g, "")))) { leaks.phone++; hit = true; }
      if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) { leaks.email++; hit = true; }
      if (/\d{9,}/.test(s)) { leaks.longNumber++; hit = true; if (WORDS) for (const m of s.match(/\S*\d{9,}\S*/g) ?? []) { const k = m.replace(/\d/g, "9").replace(/\p{Lu}/gu, "A").replace(/\p{Ll}/gu, "a"); shapes.set(k, (shapes.get(k) ?? 0) + 1); } }
      if (/(?<!\d)[1-8]\d{2}\s?\d{3}(?!\d)/.test(s) && ADDR.test(s)) { leaks.address++; hit = true; }
      if (hit) leakMsgs.add(n);
      const caps = (s.match(/(?<=[a-z,;] )\p{Lu}[\p{Ll}]{2,}/gu) ?? []).filter((w) => !R.commonWord(w.toLowerCase()));
      capsLeft += caps.length; if (caps.length) capsMsgs++;
      if (shown.length < SHOW) shown.push(s.replace(/\s+/g, " ").slice(0, 300));
    }
  }
  const per1000 = (x) => Math.round((10000 * x) / Math.max(1, n)) / 10;
  console.log(JSON.stringify({
    company: flag("install") || !arg("host") ? "install" : "host", sample: n, groups: byChat.size,
    vocabulary: { words: vocab.size, ms: vocabMs },
    replaced: counts,
    left: { ...leaks, messagesWithAny: leakMsgs.size, perThousandMessages: per1000(leakMsgs.size), knownByKind: byKind },
    ordinaryWordsOfNamesLeft: { words: leftOrdinary, note: "single words of client or project names the company uses as ordinary words (e.g. premium): left on purpose" },
    capitalisedWordsLeft: { words: capsLeft, messages: capsMsgs, note: "inside a sentence, not on the fixed lists: ordinary in this company's chats, or a name to look at" },
  }, null, 1));
  if (WORDS) console.log(JSON.stringify({ wordsLeft: [...leftWords].sort((a, b) => b[1] - a[1]).slice(0, 40), longNumberShapes: [...shapes] }));
  if (SHOW) { console.log(`--- ${shown.length} redacted messages (what an engine would read) ---`); for (const s of shown) console.log(s); }
} finally {
  await c.query("rollback").catch(() => {});
  await c.end();
}
