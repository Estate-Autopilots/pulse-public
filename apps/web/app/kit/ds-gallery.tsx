"use client";
// The AC design system on one page (owner workbench, 21 Oct 2026): every tier with made-up data, and a theme playground
// whose accent, roundness and density restyle every component here at once (nothing is saved from this page).
import { useState } from "react";
import { Award, Bell, CalendarCheck, Check, CheckCheck, ChevronRight, Clock3, Inbox, Plus, Settings, Sparkles, Sprout, Users, Wallet } from "lucide-react";
import { Button, Card, EmptyState, IconButton, IconTile, List, ListRow, Section, Stat, StatStrip, Tabs, Tag, type Hue } from "@pulse/design-system/ui";
import { colourFromImage, themeCss } from "@pulse/design-system/theme";
import css from "./ds-gallery.module.css";

const HUES: Hue[] = ["indigo", "green", "sky", "amber", "pink", "teal", "orange", "slate"];

export function DsGallery() {
  const [accent, setAccent] = useState("#5b45d6"), [round, setRound] = useState(1), [density, setDensity] = useState(1), [tab, setTab] = useState("today"), [note, setNote] = useState("");
  const fromLogo = async (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    try { const c = await colourFromImage(url); if (c) { setAccent(c); setNote(`Picked ${c} from ${file.name}`); } else setNote("No brand colour found in that image"); }
    finally { URL.revokeObjectURL(url); }
  };
  return <div className={css.wrap}>
    <style>{themeCss({ accent, roundness: round, density })}</style>
    <Card title="Theme" sub="One accent, a roundness and a density restyle every component in every AC app" icon={<Sparkles />} tone="accent" pad="lg">
      <div className={css.theme}>
        <label className={css.field}><span>Accent</span><input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} /><code>{accent}</code></label>
        <label className={css.field}><span>From a logo</span><input type="file" accept="image/*" onChange={(e) => void fromLogo(e.target.files?.[0])} /></label>
        <label className={css.field}><span>Roundness {round.toFixed(2)}</span><input type="range" min={0.25} max={1.75} step={0.05} value={round} onChange={(e) => setRound(Number(e.target.value))} /></label>
        <label className={css.field}><span>Density {density.toFixed(2)}</span><input type="range" min={0.85} max={1.2} step={0.01} value={density} onChange={(e) => setDensity(Number(e.target.value))} /></label>
      </div>
      {note ? <p className={css.note}>{note}</p> : null}
    </Card>

    <Section title="Tier 1 · Primitives">
      <Card title="Buttons" sub="One primary per view; secondary, ghost, danger; three sizes; icon-only">
        <div className={css.row}>
          <Button variant="primary" icon={<Plus />}>New task</Button><Button>Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Delete</Button>
          <Button size="sm" variant="primary">Small</Button><Button size="lg" variant="primary" icon={<Check />}>Large</Button><Button disabled>Disabled</Button>
          <IconButton label="Notifications" icon={<Bell />} /><IconButton label="Settings" icon={<Settings />} variant="secondary" /><IconButton label="Add" icon={<Plus />} variant="primary" round />
        </div>
      </Card>
      <Card title="Icon tiles and tags" sub="A category keeps its hue in every app">
        <div className={css.row}>{HUES.map((h) => <IconTile key={h} hue={h} icon={<Sprout />} />)}</div>
        <div className={css.row}>{HUES.map((h) => <Tag key={h} hue={h}>{h}</Tag>)}<Tag>neutral</Tag><Tag hue="green" icon={<Check />}>Approved</Tag></div>
      </Card>
    </Section>

    <Section title="Tier 2 · Components">
      <Card pad="none"><div style={{ padding: "4px 18px 0" }}>
        <Tabs current={tab} onSelect={setTab} items={[{ key: "today", label: "Today", icon: <CalendarCheck /> }, { key: "time", label: "Time", icon: <Clock3 /> },
          { key: "growth", label: "Growth", icon: <Sprout /> }, { key: "requests", label: "Requests", icon: <Inbox />, count: 3 }, { key: "me", label: "About me", icon: <Users /> }]} /></div>
        <div style={{ padding: 18 }}><StatStrip><Stat value="8" label="finished" delta={{ text: "+3", dir: "up" }} /><Stat value="5" label="accepted" /><Stat value="4" unit="days" label="streak" /><Stat value="6h 12m" label="checked in" /><Stat value="37" label="work units" delta={{ text: "-2", dir: "down" }} /></StatStrip></div>
      </Card>
      <div className={css.grid}>
        <Card title="Today" icon={<CalendarCheck />} action={<a href="#">My work</a>}>
          <List label="Due today">
            <ListRow icon={<IconTile icon={<Inbox />} hue="amber" size="sm" />} title="Review Kwality Worli cut" sub="Due 4:00 PM · doing" meta="2h" href="#" chevron />
            <ListRow icon={<IconTile icon={<Wallet />} hue="green" size="sm" />} title="Approve Opinem's leave" sub="Thu–Fri · 2 days" meta="new" href="#" chevron />
          </List>
        </Card>
        <Card title="All clear" icon={<CheckCheck />} hue="green"><EmptyState icon={<CheckCheck />} title="Nothing waiting">Nothing due today and nothing waiting for you.</EmptyState></Card>
        <Card title="Recognition" icon={<Award />} hue="pink" href="#"><Stat value="3" label="thank-yous this week" /></Card>
        <Card title="Time off" icon={<Clock3 />} hue="sky" action={<Button size="sm" variant="ghost" iconEnd={<ChevronRight />}>Apply</Button>}><Stat value="1" unit="day" label="of leave left" /></Card>
      </div>
      <Card><EmptyState center icon={<Inbox />} hue="indigo" title="No workflows yet" action={<Button variant="primary" icon={<Plus />}>Start from a template</Button>}>
        Pick an industry template (real estate, agency, clinic) or start from an empty canvas.</EmptyState></Card>
    </Section>
  </div>;
}
