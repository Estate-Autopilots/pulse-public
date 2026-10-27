"use client";
// TASKS-4A: every kit control on one page (/kit), with made-up people, for review, screenshots and the browser checks.
import { useRef, useState } from "react";
import { Ban, CalendarDays, CircleDot, Copy, Flag, Gem, Hammer, Clapperboard, Megaphone, MoreHorizontal, Pencil, Receipt, Rows3, Table2, Trash2, Columns3, ThumbsUp, Sparkles, Hand } from "lucide-react";
import { AiBadge, Avatar, Combobox, DateField, DatePicker, Switch, HelpHint, KeyHint, Keycap, MentionInput, Menu, PeopleInput, PersonChip, AvatarStack, PersonSelect, Popover, Rating, Segmented, Select, Tooltip, type DateTime, type MentionHandle, type PickPerson } from ".";
import { BillingGallery } from "./billing-gallery";
import css from "./gallery.module.css";

const PEOPLE: PickPerson[] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Asha Kireteso", role: "HR executive", pod: "Shared" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Rovan Iyer", role: "Engineer", pod: "Tech", canAssign: false },
  { id: "00000000-0000-4000-8000-000000000003", name: "Meera Jivop", role: "Finance", pod: "Shared" },
  { id: "00000000-0000-4000-8000-000000000004", name: "Kedab Mifos", role: "Co-founder", pod: "Leadership" },
  { id: "00000000-0000-4000-8000-000000000005", name: "Neha Soniba", role: "Chief of staff", pod: "Leadership" },
  { id: "00000000-0000-4000-8000-000000000006", name: "Vikram Seduh", role: "Video editor", pod: "Pod 1" },
];
const KINDS = [
  { value: "video", label: "Video editing", icon: <Clapperboard size={15} aria-hidden="true" />, keywords: "reel edit cut" },
  { value: "shoot", label: "Shoot", icon: <CircleDot size={15} aria-hidden="true" />, keywords: "drone camera" },
  { value: "finance", label: "Finance", icon: <Receipt size={15} aria-hidden="true" />, keywords: "gst invoice" },
  { value: "marketing", label: "Marketing", icon: <Megaphone size={15} aria-hidden="true" /> },
  { value: "build", label: "Engineering", icon: <Hammer size={15} aria-hidden="true" /> },
];

export function KitGallery({ today }: { today: string }) {
  const [view, setView] = useState<"list" | "board" | "table">("list"), [remind, setRemind] = useState(true);
  const [kind, setKind] = useState<string | null>(null), [status, setStatus] = useState<string | null>("open");
  const [who, setWho] = useState<string | null>(PEOPLE[0].id), [team, setTeam] = useState<string[]>([PEOPLE[2].id]);
  const [due, setDue] = useState<DateTime>({ date: null, time: null }), [due2, setDue2] = useState<DateTime>({ date: today, time: "17:00" });
  const [stars, setStars] = useState<number | null>(4), [level, setLevel] = useState<number | null>(null);
  const [text, setText] = useState(""), [said, setSaid] = useState("");
  const [pop, setPop] = useState(false); const anchor = useRef<HTMLButtonElement>(null);
  const mention = useRef<MentionHandle>(null);
  return <div className={css.grid}>
    <section className={css.card} aria-labelledby="k-seg"><h2 id="k-seg">Segmented control</h2>
      <Segmented label="View" value={view} onChange={setView} options={[{ value: "list", label: "List", icon: Rows3 }, { value: "board", label: "Board", icon: Columns3 }, { value: "table", label: "Table", icon: Table2 }]} />
      <Segmented label="View (icons)" iconOnly size="sm" value={view} onChange={setView} options={[{ value: "list", label: "List", icon: Rows3 }, { value: "board", label: "Board", icon: Columns3 }, { value: "table", label: "Table", icon: Table2 }]} />
      <p className={css.note}>Chosen: <b>{view}</b></p>
    </section>
    <section className={css.card} aria-labelledby="k-combo"><h2 id="k-combo">Combobox and Select</h2>
      <label className={css.row}><span>Kind</span><Combobox label="Kind of work" options={KINDS} value={kind} onChange={setKind} hint={<><Sparkles size={14} aria-hidden="true" /><b>Video editing</b> read from the title</>} noneLabel="Read from the title" /></label>
      <label className={css.row}><span>Status</span><Select label="Status" value={status} onChange={setStatus} options={[{ value: "open", label: "To do" }, { value: "doing", label: "Doing" }, { value: "blocked", label: "Blocked", icon: <Ban size={15} aria-hidden="true" /> }, { value: "done", label: "Done" }]} /></label>
    </section>
    <section className={css.card} aria-labelledby="k-people"><h2 id="k-people">People</h2>
      <div className={css.row}><span>Who</span><PersonSelect label="Who does it" people={PEOPLE} value={who} onChange={(p) => setWho(p?.id ?? null)} me={PEOPLE[4].id} askTag={<span>Ask</span>} /></div>
      <div className={css.row}><span>People</span><PeopleInput label="People" people={PEOPLE} value={team} onChange={setTeam} /></div>
      <div className={css.chips}><PersonChip person={PEOPLE[1]} /><PersonChip person={PEOPLE[3]} short tone="accent" /><PersonChip person={PEOPLE[5]} size="sm" onRemove={() => undefined} /><AvatarStack people={PEOPLE} max={4} label="Working on it" /></div>
    </section>
    <section className={css.card} aria-labelledby="k-ai"><h2 id="k-ai">AI employees</h2>
      <div className={css.chips}><Avatar name="Studio Assistant" ai size={40} /><span>Studio Assistant<AiBadge employeeId="DEMO-AI-001" /></span><AiBadge size="md" /></div>
      <p className={css.note}>AI employees have a square avatar and an AI mark. People keep their usual avatar.</p>
    </section>
    <section className={css.card} aria-labelledby="k-date"><h2 id="k-date">Date picker</h2>
      <div className={css.row}><span>Due</span><DatePicker label="Due" value={due} onChange={setDue} today={today} /></div>
      <div className={css.row}><span>With time</span><DatePicker label="Due with time" value={due2} onChange={setDue2} today={today} withTime variant="chip" /></div>
      {/* UI-POLISH: the form's date (a drop-in for <input type="date">). The SelectField is not shown here: its hidden select's options would join the gallery's option counts in kit.spec. */}
      <div className={css.row}><span>Form date</span><DateField aria-label="Form date" name="day" defaultValue={today} /></div>
    </section>
    {/* UI-POLISH-3: the yes/no setting, in a settings list and inline in a form. */}
    <section className={css.card} aria-labelledby="k-switch"><h2 id="k-switch">Switch</h2>
      <Switch label="Remind people to check in" hint="At most twice a day, never in quiet hours." checked={remind} onChange={setRemind} states={["On", "Off"]} />
      <Switch inline label="Paid leave" defaultChecked name="paid" />
      <Switch label="Breaks are paid" hint="Only organisation admins change this." checked={false} disabled />
    </section>
    <section className={css.card} aria-labelledby="k-mention"><h2 id="k-mention">Mention input</h2>
      <div className={css.field}><MentionInput ref={mention} label="What needs doing" people={PEOPLE} me={PEOPLE[4].id} singleLine placeholder={["Edit the Lodha reel…", "Send the CA the GST pack…", "Book the drone for Saturday…"]}
        onChange={(t) => setText(t)} onSubmit={() => { setSaid(mention.current?.text() ?? ""); mention.current?.clear(); }} /></div>
      <p className={css.note}>{said ? <>Sent: <b>{said}</b></> : text ? <>Typing: {text}</> : <KeyHint keys="Enter">to send · type @ for people</KeyHint>}</p>
    </section>
    <section className={css.card} aria-labelledby="k-rate"><h2 id="k-rate">Rating</h2>
      <Rating label="Quality" value={stars} onChange={setStars} words={["Poor", "Fair", "Good", "Great", "Outstanding"]} />
      <Rating label="How was the work" value={level} onChange={setLevel} levels={[{ value: 3, label: "Great", icon: <Sparkles size={14} aria-hidden="true" />, tone: "var(--theme-success)" }, { value: 2, label: "Good", icon: <ThumbsUp size={14} aria-hidden="true" /> }, { value: 1, label: "Needs work", icon: <Hand size={14} aria-hidden="true" />, tone: "var(--theme-warning)" }]} />
      <Rating label="Read-only" value={3} readOnly size={16} />
    </section>
    <section className={css.card} aria-labelledby="k-tips"><h2 id="k-tips">Tooltip, help, menu, popover, keycaps</h2>
      <div className={css.chips}>
        <Tooltip content="Create a task or a project" shortcut="C"><button type="button" className={css.btn}>+ New</button></Tooltip>
        <span className={css.inline}>Pool <HelpHint label="What is the pool?" title="The pool">Nobody has it yet. Anyone in the company can claim it; the first claim wins, and its value is theirs when the work is accepted.</HelpHint></span>
        <Menu label="Task actions" buttonLabel="More actions" className={css.btn} items={[{ key: "edit", label: "Edit", icon: <Pencil size={15} aria-hidden="true" />, shortcut: "E" }, { key: "copy", label: "Copy link", icon: <Copy size={15} aria-hidden="true" /> },
          { key: "flag", label: "Mark urgent", icon: <Flag size={15} aria-hidden="true" />, hint: "Moves it to the top" }, { key: "del", label: "Delete", icon: <Trash2 size={15} aria-hidden="true" />, danger: true, separator: true }]}><MoreHorizontal size={16} aria-hidden="true" /></Menu>
        <button ref={anchor} type="button" className={css.btn} aria-expanded={pop} onClick={() => setPop((o) => !o)}><Gem size={14} aria-hidden="true" />Value</button>
        <Popover open={pop} onClose={() => setPop(false)} anchor={anchor} label="How value works"><div style={{ padding: 14, maxWidth: 280 }}><b>8 points</b><p className={css.note}>Unlocks two tasks for Asha; client work.</p><button type="button" className={css.btn} onClick={() => setPop(false)}>Close</button></div></Popover>
      </div>
      <p className={css.note}><Keycap keys="C" /> create · <Keycap keys="N" /> new task · <Keycap keys={["Mod", "K"]} /> search · <KeyHint keys="Enter">create task</KeyHint></p>
      <p className={css.note}><CalendarDays size={13} aria-hidden="true" /> Everything here works with the keyboard, touch and screen readers, in light and dark, at 390 px.</p>
    </section>
    <BillingGallery />
  </div>;
}
