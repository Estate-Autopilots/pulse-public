"use client";
// UX-GAMIFY: the game-feel kit on /kit, with made-up data (nothing here reads or writes data).
import { useRef, useState } from "react";
import { Coins, FileSignature, Sparkles, Users } from "lucide-react";
import { trendOf } from "../../lib/game.mjs";
import { ActionButton, Chip, DayRing, EmptyState, FuelGauge, GameCard, LevelBadge, ListRow, ListRows, Milestone, PageHeader, ProgressRing, Quest, QuestList, SegmentedTabs, Skeleton,
  StatTile, StatTiles, Stepper, StickyBar, StreakChip, WeeklyRecap, celebrate, gameCss as css, toast } from ".";

export function GameGallery() {
  const [tab, setTab] = useState<"all" | "mine" | "done">("all");
  const [ms, setMs] = useState(0);
  const burstAt = useRef<HTMLButtonElement>(null);
  return <section aria-label="Game-feel kit" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <PageHeader eyebrow="Game-feel kit" title="Fun, but useful" subtitle="Shared pieces for every new screen. One primary button per view; motion stops when Fun effects are off."
      side={<><StreakChip days={5} /><LevelBadge xp={320} /></>} primary={{ label: "Main action", onClick: () => toast("The one main action.") }} />
    <StatTiles>
      <StatTile label="Money at risk" value="₹6.4 L" icon={Coins} tone="bad" trend={trendOf(64, 52, "down")} trendLabel="vs last week" spark={[4, 5, 5, 6, 5, 7, 6.4]} />
      <StatTile label="Collected today" value="₹48,500" tone="good" trend={trendOf(48500, 41000)} spark={[2, 3, 2, 4, 3, 5, 4.8]} />
      <StatTile label="Signed this month" value={7} icon={FileSignature} trend={trendOf(7, 7)} />
      <StatTile label="New clients" value={3} icon={Users} href="/kit" />
    </StatTiles>
    <div className={css.gallery}>
      <GameCard title="Rings"><div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}><ProgressRing value={0.68} label="68% done" size={72} /><DayRing done={3} total={7} /></div></GameCard>
      <GameCard title="Streak and level"><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><StreakChip days={0} /><StreakChip days={12} what="check-in day" /><LevelBadge xp={40} /></div></GameCard>
      <GameCard title="Fuel gauges"><div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
        <FuelGauge left={68} label="Plan A" sub="refills in 2 h" size={110} /><FuelGauge left={28} label="Plan B" size={110} /><FuelGauge left={null} label="Plan C" size={110} /></div></GameCard>
      <GameCard title="Stepper"><Stepper steps={["Pick the deal", "Fill the gaps", "Check", "Send to sign"]} current={2} /></GameCard>
      <GameCard title="Segmented tabs with counts"><SegmentedTabs label="Show" value={tab} onChange={setTab} options={[{ value: "all", label: "All", count: 12 }, { value: "mine", label: "Mine", count: 4 }, { value: "done", label: "Done", count: 8 }]} /></GameCard>
      <GameCard title="Toast and celebration"><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ActionButton small action={{ label: "Toast with Undo", onClick: () => toast("Task moved to Done.", { undo: () => toast("Undone.") }) }} />
        <button ref={burstAt} type="button" className={`${css.quiet} ${css.small}`} onClick={() => celebrate(burstAt.current)}>Small burst</button>
        <ActionButton small action={{ label: "Level up", icon: Sparkles, onClick: () => setMs((n) => n + 1) }} /></div>
        <Milestone show={ms > 0} id={`kit-level-${ms}`} once={false} title="Level up! Level 4" text="You hit your goal of 10 calls." /></GameCard>
      <GameCard title="Quest list" label="Quest list example"><QuestList label="Example quests">
        <Quest title="Call Lotus Interiors" sub="₹1.2 L due" end={<Chip tone="accent">Quick win</Chip>} onToggle={() => undefined} color="#6B4CF0" />
        <Quest title="Send the quote" state="done" sub="Harbor Builders" color="#16A34A" />
        <Quest title="Start the site visit" state="wait" sub="After the drawings come" color="#D97706" />
      </QuestList></GameCard>
      <GameCard title="Card list rows"><ListRows label="Example rows">
        <li><ListRow lead="LI" title="Lotus Interiors" sub="Design fee · ₹4.2 L" end={<Chip tone="good">Signed</Chip>} href="/kit" /></li>
        <li><ListRow lead="HB" title="Harbor Builders" sub="Build and fit-out · ₹18 L" end={<Chip tone="warn">Out to sign</Chip>} stripe="#D97706" /></li>
      </ListRows></GameCard>
      <GameCard title="Empty state"><EmptyState art="done" title="All done for today" text="Nothing waits for you. Enjoy the quiet." action={{ label: "Plan tomorrow", href: "/kit" }} /></GameCard>
      <GameCard title="Skeleton"><Skeleton width="60%" /><Skeleton height={48} radius={12} /><Skeleton height={48} radius={12} /></GameCard>
      <div className={css.wide}><WeeklyRecap streak={4} items={[{ label: "Tasks done", value: 12 }, { label: "Collected", value: "₹3.2 L" }, { label: "Calls", value: 38 }, { label: "Check-ins", value: "5 of 5" }]} /></div>
    </div>
    <StickyBar text="2 unsaved changes"><ActionButton small action={{ label: "Discard", onClick: () => toast("Discarded.") }} /><ActionButton small primary action={{ label: "Save", onClick: () => toast("Saved.") }} /></StickyBar>
  </section>;
}
