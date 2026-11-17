"use client";
// R47: the preview runs here, on this device: the export is read and shown without being sent anywhere. Only "Import"
// sends the file, with each sender's decision and the owner's approval, and the server reads it again the same way.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FileArchive, FileText, Lock, ShieldCheck, TriangleAlert } from "lucide-react";
import { decodeExport, displayLabel, ExportError, importKeys, parseWhatsAppExport, participantKey, sha256Hex, suggestPeople, validZone, type DateOrder, type ExportMessage, type ExportWarning, type ParsedExport, type Suggestion } from "@pulse/chat-export";
import { Badge, styles } from "../../ui";
import { send } from "../net";
import css from "./import.module.css";
import { SelectField } from "../../kit/select-field";
import { W } from "../../kit/word";
import { usePrompt } from "../../kit/dialogs";

type Person = { id: string; name: string; current: boolean };
type Target = { id: string; kind: "custom" | "direct"; name: string; readers: { id: string; name: string }[] };
type Batch = { id: string; channelId: string; channel: string; kind: string; timeZone: string; dateOrder: DateOrder; approvalRef: string; retentionNote: string; approvedBy: string; approvedAt: string; added: number; duplicates: number;
  withdrawnBy: string | null; withdrawnAt: string | null; withdrawnNote: string | null; member: boolean; fileBytes: number };
export type ImportPage = { enabled: boolean; parser: string; timeZone: string; targets: Target[]; people: Person[]; batches: Batch[] };
type Choice = { personId: string | null; skip: boolean } | null;

const ORDER: Record<DateOrder, string> = { dmy: "day first: 12/10 is 12 Oct", mdy: "month first: 10/12 is 12 Oct", ymd: "year first: 2026-10-12" };
const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];
// One fixed locale and the company's zone, so the server's first render and the browser's agree.
const num = (n: number) => n.toLocaleString("en-IN");
const count = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const shown = (local: string) => `${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)} ${local.slice(11, 16)}`;
function warning(w: ExportWarning) {
  switch (w.code) {
    case "date_order_guess": return `Dates could be day-first or month-first. Read as ${ORDER[w.order]}; check the dates below, or choose how they are written.`;
    case "leading_lines": return `${count(w.count, "line")} before the first message belong to no message and are left out.`;
    case "bad_stamp": return `${count(w.count, "line")} look like a new message but carry a date that does not exist (first at line ${w.line}); they stay part of the message before.`;
    case "time_ambiguous": return `${count(w.count, "message")} were sent in the hour a clock change repeats (first at line ${w.line}); the earlier time is used and marked.`;
    case "time_missing": return `${count(w.count, "message")} carry a time the clock skipped (first at line ${w.line}); they are marked.`;
    case "out_of_order": return `${count(w.count, "message")} come earlier than the one before. Check the time zone and how dates are written.`;
    case "long_message": return `${count(w.count, "very long message")} are cut at 12,000 characters.`;
    case "phone_senders": return `${count(w.count, "sender")} ${w.count === 1 ? "is" : "are"} only a phone number: Pulse shows and keeps “Number ending …”, never the number.`;
  }
}
function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// CHAT-VOICE-FIX (Kazuk, 14 Nov 2026): WhatsApp's "Export chat → Include media" makes a .zip: the chat's text and the photos,
// voice notes, videos and documents it names. The text is read exactly as a .txt; each file a kept message names comes
// after the import (up to 5 MB each), tied to that message.
type Media = { name: string; read: () => Promise<Uint8Array> };
const MEDIA_MAX = 5 * 1024 * 1024, ZIP_MAX = 400 * 1024 * 1024;
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", opus: "audio/ogg", ogg: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", "3gp": "video/3gpp", mov: "video/quicktime", pdf: "application/pdf", vcf: "text/vcard" };
const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
const baseName = (path: string) => path.split("/").pop() ?? path;
/** The file a media line names: iPhone "<attached: 0003-PHOTO-….jpg>", Android "IMG-….jpg (file attached)". */
export function mediaName(line: string) {
  const ios = /<attached:\s*([^>]+)>/i.exec(line);
  if (ios) return ios[1].trim();
  const android = /([^:\u200e\u200f]+?\.[A-Za-z0-9]{1,6})\s*\(file attached\)\s*$/i.exec(line);
  return android ? android[1].trim() : null;
}

export function ImportApp({ page, channel = null }: { page: ImportPage; channel?: string | null }) {
  const ask = usePrompt();
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; text: string; sha: string; media: Map<string, Media> | null } | null>(null), [fileError, setFileError] = useState("");
  const [sending, setSending] = useState<{ done: number; of: number } | null>(null);
  const [zone, setZone] = useState(page.timeZone), [order, setOrder] = useState<DateOrder | "auto">("auto");
  const [keyed, setKeyed] = useState<{ of: ParsedExport | null; map: Record<string, string> }>({ of: null, map: {} });
  const [edits, setEdits] = useState<{ of: ParsedExport | null; map: Record<string, Choice> }>({ of: null, map: {} });
  const [target, setTarget] = useState(channel && page.targets.some((t) => t.id === channel) ? channel : page.targets.length === 1 ? page.targets[0].id : ""), [approvalRef, setApprovalRef] = useState(""), [retention, setRetention] = useState(""), [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState<{ added: number; duplicates: number; channelId: string; files: number; tooBig: number; missing: number } | null>(null);
  const zoneOk = validZone(zone);
  const preview = useMemo((): ParsedExport | string | null => {
    if (!file || !zoneOk) return null;
    try { return parseWhatsAppExport(file.text, { timeZone: zone, dateOrder: order }); } catch (e) { return e instanceof ExportError ? e.message : "This file could not be read"; }
  }, [file, zone, order, zoneOk]);
  const parsed = typeof preview === "object" ? preview : null;
  const suggestions = useMemo(() => parsed ? suggestPeople(parsed.participants, page.people) : [], [parsed, page.people]);
  // A new reading starts every sender undecided, except one person with exactly the same name.
  const choices = useMemo(() => {
    const start: Record<string, Choice> = Object.fromEntries((parsed?.participants ?? []).map((p, i) => [p.label, suggestions[i]?.status === "same_name" ? { personId: suggestions[i].candidates[0], skip: false } : null]));
    return edits.of === parsed ? { ...start, ...edits.map } : start;
  }, [parsed, suggestions, edits]);
  const decide = (label: string, c: Choice) => setEdits({ of: parsed, map: { ...(edits.of === parsed ? edits.map : {}), [label]: c } });
  useEffect(() => {
    if (!parsed) return;
    let live = true;
    void Promise.all(parsed.participants.map(async (p) => [p.label, await participantKey(p.label)] as const)).then((pairs) => { if (live) setKeyed({ of: parsed, map: Object.fromEntries(pairs) }); });
    return () => { live = false; };
  }, [parsed]);
  const keys = keyed.of === parsed ? keyed.map : null;
  const when = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: page.timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  async function choose(f: File | undefined) {
    setFile(null); setFileError(""); setOrder("auto"); setResult(null);
    if (!f) return;
    try {
      let bytes: Uint8Array = new Uint8Array(await f.arrayBuffer()), name = f.name, media: Map<string, Media> | null = null;
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        if (bytes.length > ZIP_MAX) { setFileError("This .zip is over 400 MB. Export the chat again with less history, or without media."); return; }
        const JSZip = (await import("jszip")).default, zip = await JSZip.loadAsync(bytes);
        const entries = Object.values(zip.files).filter((e) => !e.dir && !baseName(e.name).startsWith("."));
        const chat = entries.find((e) => /^_chat\.txt$/i.test(baseName(e.name))) ?? entries.find((e) => /\.txt$/i.test(e.name));
        if (!chat) { setFileError("This .zip has no chat text in it. Choose the .zip WhatsApp made with Export chat."); return; }
        media = new Map(entries.filter((e) => e !== chat).map((e) => [baseName(e.name), { name: baseName(e.name), read: () => e.async("uint8array") }]));
        bytes = await chat.async("uint8array"); name = `${f.name} → ${baseName(chat.name)}`;
      }
      setFile({ name, bytes, text: decodeExport(bytes), sha: await sha256Hex(bytes), media });
    }
    catch (e) { setFileError(e instanceof ExportError ? e.message : "This file could not be read"); }
  }
  const undecided = parsed ? parsed.participants.filter((p) => !choices[p.label]).length : 0;
  const kept = parsed ? parsed.messages.filter((m) => (m.kind === "text" || m.kind === "media") && m.sender !== null && !choices[m.sender]?.skip).length : 0;
  const chosen = page.targets.find((t) => t.id === target);
  const ready = !!parsed && !undecided && kept > 0 && !!chosen && approvalRef.trim().length >= 3 && retention.trim().length >= 3 && approved && !!keys;
  async function importNow() {
    if (!parsed || !file || !keys || !ready) return;
    setBusy(true); setError("");
    try {
      const r = await send<{ id: string; added: number; duplicates: number }>("chats/imports", {
        channelId: target, file: base64(file.bytes), fileSha256: file.sha, timeZone: parsed.timeZone, dateOrder: parsed.dateOrder, expectMessages: parsed.stats.messages,
        participants: parsed.participants.map((p) => ({ key: keys[p.label], personId: choices[p.label]?.personId ?? null, skip: !!choices[p.label]?.skip })), approvalRef: approvalRef.trim(), retentionNote: retention.trim(),
      });
      const media = file.media ? await sendMedia(parsed, file.text, file.media) : { files: 0, tooBig: 0, missing: 0 };
      setResult({ added: r.added, duplicates: r.duplicates, channelId: target, ...media }); setApproved(false); router.refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** After the text: each file a kept message names, tied to it by the import key the server gave it (same reader). */
  async function sendMedia(p: ParsedExport, text: string, media: Map<string, Media>) {
    const kept = p.messages.filter((m): m is ExportMessage & { sender: string } => (m.kind === "text" || m.kind === "media") && m.sender !== null && !choices[m.sender]?.skip);
    const keyOf = await importKeys(kept), lines = text.split(/\r?\n/);
    const wanted = kept.map((m, i) => ({ m, key: keyOf[i] })).filter((x) => x.m.kind === "media").map((x) => ({ ...x, name: mediaName(lines[x.m.line - 1] ?? "") }));
    let files = 0, tooBig = 0, missing = 0;
    setSending({ done: 0, of: wanted.length });
    for (const [i, w] of wanted.entries()) {
      const f = w.name ? media.get(w.name) : undefined;
      if (!f) missing++;
      else {
        const bytes = await f.read();
        if (bytes.length > MEDIA_MAX) tooBig++;
        else { await send(`chats/imports/${target}/files`, { importKey: w.key, name: f.name, mime: mimeOf(f.name), bytes: base64(bytes) }); files++; }
      }
      setSending({ done: i + 1, of: wanted.length });
    }
    setSending(null);
    return { files, tooBig, missing };
  }
  async function withdraw(b: Batch) {
    const note = await ask({ title: `Take back the import into ${b.channel}?`, body: "Its messages are hidden from everyone. Nothing is deleted.", label: "Why are you taking it back?", helper: "We keep this note with the import.", confirmLabel: "Take back import", multiline: true, minLength: 3, maxLength: 300, danger: true });
    if (!note) return;
    try { await send(`chats/imports/${b.id}/withdraw`, { note }); router.refresh(); } catch (e) { setError((e as Error).message); }
  }

  const sample = parsed ? parsed.messages.filter((m) => m.kind !== "system") : [];
  return <div className={css.page}>
    {!page.enabled ? <p className={styles.banner}><Lock size={16} aria-hidden="true" />Real imports are off on this server until the owner approves them (E15). The preview works: it reads the file on this device and sends nothing.</p> : null}

    <section className={css.step} aria-labelledby="r47-file">
      <h2 id="r47-file"><span>1</span>Choose the export</h2>
      <ol className={css.how}>
        <li>On your phone, open the chat in WhatsApp.</li>
        <li>Tap ⋮, then More, then Export chat, then <b>Include media</b>.</li>
        <li>Choose that file below. Nothing is sent until you press Import.</li>
      </ol>
      <div className={css.row}>
        <label className={`${styles.field} ${css.pick}`}>WhatsApp export (.zip or .txt)
          <input type="file" accept=".txt,.zip,text/plain,application/zip" data-import-file="" onChange={(e) => void choose(e.target.files?.[0])} />
          <span className={css.pickBox}><span className={`${styles.btn} ${styles.btnSecondary}`}><FileArchive size={16} aria-hidden="true" />Choose file</span><span className={css.pickName}>{file ? file.name.split(" → ")[0] : "No file chosen"}</span></span>
        </label>
        <label className={styles.field}>Time zone of the phone that exported it
          <input list="r47-zones" value={zone} onChange={(e) => setZone(e.target.value.trim())} aria-invalid={!zoneOk || undefined} />
          <datalist id="r47-zones">{[...new Set([page.timeZone, ...ZONES])].map((z) => <option key={z} value={z} />)}</datalist>
        </label>
        <label className={styles.field}>How dates are written
          <SelectField value={order} onChange={(e) => setOrder(e.target.value as DateOrder | "auto")}>
            <option value="auto">{parsed && order === "auto" ? `${ORDER[parsed.dateOrder][0].toUpperCase()}${ORDER[parsed.dateOrder].slice(1)}` : "Find out from the file"}</option>
            {(Object.keys(ORDER) as DateOrder[]).map((k) => <option key={k} value={k}>{ORDER[k][0].toUpperCase() + ORDER[k].slice(1)}</option>)}
          </SelectField>
        </label>
      </div>
      {parsed && order === "auto" && !parsed.dateOrderCertain ? <p className={css.problem}>We are not sure how dates are written: check the dates in the preview below.</p> : null}
      {!zoneOk ? <p role="alert" className={css.problem}>Choose a time zone such as Asia/Kolkata.</p> : null}
      {fileError || typeof preview === "string" ? <p role="alert" className={css.problem}>{fileError || (typeof preview === "string" ? preview : "")}</p> : null}
    </section>

    {parsed && file ? <>
      <section className={css.step} aria-labelledby="r47-preview">
        <h2 id="r47-preview"><span>2</span>Check the preview</h2>
        <p className={styles.fieldHint}>{file.media ? <FileArchive size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />} {file.name.split(" → ")[0]} · {parsed.stats.first ? `${shown(sample[0].local)} to ${shown(sample[sample.length - 1].local)}` : "no messages"}</p>
        <dl className={css.facts}>
          <div><dt>Messages</dt><dd>{parsed.stats.text.toLocaleString("en-IN")}</dd></div>
          <div><dt>Photos and files</dt><dd>{parsed.stats.media.toLocaleString("en-IN")}<small>{file.media ? `${count(file.media.size, "file")} found in the .zip` : "export with media to bring the files"}</small></dd></div>
          <div><dt>Deleted</dt><dd>{parsed.stats.deleted.toLocaleString("en-IN")}<small>not imported</small></dd></div>
          <div><dt>Group updates</dt><dd>{parsed.stats.system.toLocaleString("en-IN")}<small>not imported</small></dd></div>
          <div><dt>Long messages</dt><dd>{parsed.stats.multiline.toLocaleString("en-IN")}</dd></div>
          <div><dt>Senders</dt><dd>{parsed.participants.length.toLocaleString("en-IN")}</dd></div>
        </dl>
        {parsed.warnings.length ? <ul className={css.warnings}>{parsed.warnings.map((w) => <li key={w.code}><TriangleAlert size={14} aria-hidden="true" />{warning(w)}</li>)}</ul> : null}
        <div className={styles.tableWrap}><table className={`${styles.table} ${css.sample}`}>
          <caption className={styles.srOnly}>First and last messages as Pulse reads them</caption>
          <thead><tr><th>Phone’s time</th><th>Sender</th><th>Message</th></tr></thead>
          <tbody>{(sample.length > 8 ? [...sample.slice(0, 5), null, ...sample.slice(-3)] : sample).map((m, i) => m ? <tr key={m.line}>
            <td className={css.nowrap}>{shown(m.local)}{m.time === "exact" ? "" : " ?"}</td><td>{displayLabel(m.sender ?? "")}</td>
            <td>{m.kind === "media" ? <><Badge>Photo, file or voice note{m.body ? " + caption" : ""}</Badge> </> : m.kind === "deleted" ? <Badge>Deleted</Badge> : null}{m.body.length > 160 ? `${m.body.slice(0, 160)}…` : m.body}{m.edited ? <small className={styles.muted}> (edited)</small> : null}</td>
          </tr> : <tr key={`gap-${i}`}><td colSpan={3} className={styles.muted}>… {count(sample.length - 8, "more message")}</td></tr>)}</tbody>
        </table></div>
      </section>

      <section className={css.step} aria-labelledby="r47-who">
        <h2 id="r47-who"><span>3</span>Who is who</h2>
        <p className={styles.fieldHint}>Decide every sender. Only one colleague with exactly the same name is suggested; several people with that name, a first name alone or a phone number are yours to decide. Senders who are not colleagues keep the name the export shows (a number as “Number ending …”).</p>
        <ul className={css.people}>{parsed.participants.map((p, i) => {
          const s: Suggestion | undefined = suggestions[i], c = choices[p.label];
          const value = !c ? "" : c.skip ? "skip" : c.personId ?? "kept";
          return <li key={p.label}>
            <span><b>{p.display}</b><small>{count(p.messages, "message")}{p.media ? ` · ${p.media} media` : ""}</small></span>
            {s?.status === "same_name" ? <Badge tone="success">Same name in Pulse</Badge> : s?.status === "several" ? <Badge tone="warning">{s.candidates.length} colleagues with this name</Badge>
              : s?.status === "first_name" ? <Badge tone="warning">First name only</Badge> : s?.status === "phone" ? <Badge>Phone number</Badge> : <Badge>No colleague by this name</Badge>}
            <SelectField className={styles.input} value={value} aria-label={`Who is ${p.display}`} aria-invalid={!c || undefined}
              onChange={(e) => decide(p.label, e.target.value === "" ? null : e.target.value === "skip" ? { personId: null, skip: true } : e.target.value === "kept" ? { personId: null, skip: false } : { personId: e.target.value, skip: false })}>
              <option value="">Choose…</option>
              {s?.candidates.length ? <optgroup label="Suggested">{s.candidates.map((id) => { const x = page.people.find((y) => y.id === id); return x ? <option key={id} value={id}>{x.name}{x.current ? "" : " (former)"}</option> : null; })}</optgroup> : null}
              <optgroup label="Not a colleague"><option value="kept">Not in Pulse: keep the name as written</option><option value="skip">Not a person: leave these lines out</option></optgroup>
              <optgroup label="Colleagues">{page.people.map((x) => <option key={x.id} value={x.id}>{x.name}{x.current ? "" : " (former)"}</option>)}</optgroup>
            </SelectField>
          </li>;
        })}</ul>
        {undecided ? <p className={css.problem}>{count(undecided, "sender")} still to decide.</p> : null}
      </section>

      <section className={css.step} aria-labelledby="r47-where">
        <h2 id="r47-where"><span>4</span>Where it goes, and the owner’s approval</h2>
        {page.targets.length ? <label className={styles.field}>Conversation
          <SelectField value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a group or direct chat you are in…</option>
            {page.targets.map((t) => <option key={t.id} value={t.id}>{t.kind === "direct" ? `Direct chat with ${t.name}` : t.name}</option>)}
          </SelectField>
        </label> : <p className={css.problem}>You are not in a group or direct chat that can take history. Make a group with exactly the people who may read it (Chats → New group), then come back.</p>}
        {chosen ? <p className={styles.fieldHint}><ShieldCheck size={14} aria-hidden="true" /> Only {count(chosen.readers.length, "member")} of {chosen.kind === "direct" ? "this chat" : chosen.name} will read it: {chosen.readers.map((r) => r.name).join(", ")}. Nobody reads it by role (not admins, HR or leadership), and it feeds nothing else in Pulse.</p> : null}
        <p className={styles.fieldHint}><W k="teams" />, <W k="function" lc />s and Google groups cannot take history: their members follow the roster and roles.</p>
        <div className={css.row}>
          <label className={styles.field}>Where the owner’s approval is recorded<input value={approvalRef} onChange={(e) => setApprovalRef(e.target.value)} maxLength={200} placeholder="e.g. E15 decision of 12 Oct 2026" /></label>
          <label className={styles.field}>Retention proposal (for legal review; nothing is deleted automatically)<input value={retention} onChange={(e) => setRetention(e.target.value)} maxLength={300} placeholder="e.g. keep while the group exists" /></label>
        </div>
        <label className={css.check}><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />The owner approved this export: the company may import it, who reads it, the sender decisions above and the retention proposal. {file.media ? "The text, and the photos, voice notes and files in the .zip." : "Text only."}</label>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
        {sending ? <p role="status" className={styles.banner} data-import-sending="">Adding photos, voice notes and files: {num(sending.done)} of {num(sending.of)}…</p> : null}
        {result ? <p role="status" className={styles.banner} data-import-done=""><ShieldCheck size={16} aria-hidden="true" />Imported {count(result.added, "new message")}{result.duplicates ? `; ${count(result.duplicates, "message was", "messages were")} already there` : ""}{result.files ? `, with ${count(result.files, "photo, voice note or file", "photos, voice notes and files")}` : ""}{result.tooBig ? ` (${count(result.tooBig, "file")} over 5 MB left out)` : ""}{result.missing ? ` (${count(result.missing, "file")} not in the .zip)` : ""}. <Link href={`/chats?channel=${result.channelId}`}>Open the chat</Link></p> : null}
        <div className={css.actions}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!page.enabled || !ready || busy} onClick={() => void importNow()}>{busy ? (sending ? "Adding files…" : "Importing…") : `Import ${count(kept, "message")}`}</button>
          {!page.enabled ? <span className={styles.muted}>Off on this server: nothing will be sent.</span> : null}
        </div>
      </section>
    </> : null}

    <section className={css.step} aria-labelledby="r47-past">
      <h2 id="r47-past">Past imports</h2>
      {page.batches.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>When</th><th>Conversation</th><th>By</th><th className={styles.right}>Added</th><th className={styles.right}>Already there</th><th>Approval</th><th /></tr></thead>
        <tbody>{page.batches.map((b) => <tr key={b.id}>
          <td className={css.nowrap}>{when(b.approvedAt)}</td>
          <td>{b.member ? <Link href={`/chats?channel=${b.channelId}`}>{b.channel}</Link> : b.channel}{b.member ? null : <small className={styles.muted}> · you are not a member</small>}</td>
          <td>{b.approvedBy}</td><td className={styles.right}>{b.added.toLocaleString("en-IN")}</td><td className={styles.right}>{b.duplicates.toLocaleString("en-IN")}</td>
          <td><span title={b.retentionNote}>{b.approvalRef}</span><small className={styles.muted}> · {b.timeZone}</small></td>
          <td>{b.withdrawnAt ? <Badge>Withdrawn {when(b.withdrawnAt)}</Badge> : <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void withdraw(b)}>Withdraw</button>}</td>
        </tr>)}</tbody>
      </table></div> : <p className={styles.muted}>No WhatsApp history has been imported.</p>}
    </section>
  </div>;
}
