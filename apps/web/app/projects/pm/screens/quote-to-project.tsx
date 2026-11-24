// PM-UI 14 Quote to project (`quote-to-project`, sheets/quote-to-project.md): Kavya sees what the accepted quote Q-1043
// turns into (each line → its step blocks, with a 97-step total) and creates the draft project in one tap.
// Same blocks in the same order at every width: title row · quote band · lines · total band · lead · note + button.
// Phone (< 600 px of content): separate blocks, step count under each name, chips at the right two per line.
// From 600 px: one card holding blocks 2–7; row = icon · name · → · chips in one line · step count in a right column.
// States: default (ready), creating, created, already-made (exists), loading. The button lives in ./quote-to-project-client.
import Link from "next/link";
import { ArrowLeft, ArrowRight, Database, Gift, Image as ImageIcon, Info, Layers, Megaphone, RefreshCw, Users, type LucideIcon } from "lucide-react";
import type { QuoteLineIcon, QuoteLineVM, QuoteToProjectVM } from "../contract/quote-to-project";
import type { ScreenProps } from "../contract/shared";
import { Chip, PmPage, ProjectTile, firstName, hued } from "../kit";
import { QuoteAction } from "./quote-to-project-client";
import css from "./quote-to-project.module.css";

const ICONS: Record<QuoteLineIcon, LucideIcon> = { image: ImageIcon, megaphone: Megaphone, database: Database, gift: Gift, refresh: RefreshCw, layers: Layers };
const steps = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;

function LineRow({ line }: { line: QuoteLineVM }) {
  const Icon = ICONS[line.icon] ?? Layers;
  const has = line.blocks.length > 0;
  return <li className={css.row}>
    <span className={css.lIcon} aria-hidden="true"><Icon /></span>
    <span className={css.lName}>{line.name}{line.tag ? <span className={`${css.tag} ${css.tagInline}`}>{line.tag}</span> : null}</span>
    <span className={css.sub}>{steps(line.steps)}</span>
    {has ? <ArrowRight className={css.arrow} aria-hidden="true" /> : null}
    {has ? <ul className={css.blocks} aria-label={`Makes ${line.blocks.join(", ")}`}>
      {line.blocks.map((b) => <li key={b} className={css.block}>{b}</li>)}
    </ul> : null}
    {line.tag ? <span className={`${css.tag} ${css.tagSide}`}>{line.tag}</span> : null}
    <span className={css.count}>{steps(line.steps)}</span>
  </li>;
}

/** Skeleton rows: the usual shape of a quote (chips per row; the "Bonus" tag where the real tag sits), so rows keep
 *  their final heights and nothing shifts on load. */
const SKELETON: { chips: number; tag?: boolean }[] = [{ chips: 2 }, { chips: 4 }, { chips: 0 }, { chips: 0, tag: true }, { chips: 3 }, { chips: 0 }];

function Skeleton() {
  return <div className={css.skel} aria-busy="true" aria-label="Loading the quote">
    <div className={`${css.band} ${css.bandSkel}`}>
      <span className={`${css.bone} ${css.tileBone}`} />
      <span className={css.bandText}><i className={`${css.bone} ${css.pkg}`} data-w="40" /><i className={`${css.bone} ${css.client}`} data-w="28" /></span>
    </div>
    <ul className={css.lines}>
      {SKELETON.map((r, i) => <li key={i} className={css.row}>
        <span className={css.lIcon}><i className={`${css.bone} ${css.iconBone}`} /></span>
        <span className={css.lName}>
          <i className={`${css.bone} ${css.nameBone}`} data-w={i % 2 ? "70" : "55"} />
          {r.tag ? <i className={`${css.bone} ${css.tagBone} ${css.tagInline}`} /> : null}
        </span>
        <i className={`${css.bone} ${css.sub}`} data-w="30" />
        {r.chips ? <span className={css.blocks}>{Array.from({ length: r.chips }, (_, k) => <i key={k} className={`${css.bone} ${css.blockBone}`} />)}</span> : null}
        {r.tag ? <i className={`${css.bone} ${css.tagBone} ${css.tagSide}`} /> : null}
        <span className={css.count}><i className={`${css.bone} ${css.countBone}`} /></span>
      </li>)}
    </ul>
    <div className={`${css.total} ${css.totalSkel}`}><i className={`${css.bone} ${css.lineBone}`} data-w="40" /></div>
    <div className={css.lead}><i className={`${css.bone} ${css.lineBone}`} data-w="25" /></div>
    <div className={css.foot}>
      <i className={`${css.bone} ${css.lineBone} ${css.noteBone}`} data-w="45" />
      <i className={`${css.bone} ${css.btnBone}`} />
    </div>
  </div>;
}

export default function QuoteToProject({ vm }: ScreenProps<QuoteToProjectVM>) {
  const { quote } = vm;
  const loading = vm.status === "loading";
  return <PmPage>
    <div className={css.wrap}>
      <header className={css.titleRow}>
        <Link href={vm.backHref} className={css.backBtn} aria-label="Projects" title="Projects"><ArrowLeft aria-hidden="true" /></Link>
        <h1 className={css.title}>New project from accepted quote {quote.number}</h1>
      </header>

      <section className={css.card} aria-label={`Quote ${quote.number}`}>
        {loading ? <Skeleton /> : <>
          <div {...hued(quote.hue, css.band)}>
            <ProjectTile project={{ hue: quote.hue, icon: quote.icon, name: quote.client }} size="lg" />
            <span className={css.bandText}>
              <strong className={css.pkg}>{quote.packageName}</strong>
              <span className={css.client}>{quote.client}</span>
            </span>
            <span className={css.accepted}><Chip tone="done">Accepted</Chip></span>
          </div>

          {vm.status === "exists" ? <p className={css.exists}><Info aria-hidden="true" />{vm.existsNote}</p> : null}

          <ul className={css.lines} aria-label="Quote lines and the steps they make">
            {vm.lines.map((l) => <LineRow key={l.id} line={l} />)}
          </ul>

          <p className={css.total}><Layers aria-hidden="true" />{steps(vm.total.steps)} in {vm.total.phases} phases</p>

          <p className={css.lead}><Users aria-hidden="true" /><span><b>Lead: {firstName(vm.lead.person)}</b>{vm.lead.suggested ? <span className={css.muted}> · suggested</span> : null}</span></p>

          <QuoteAction status={vm.status} note={vm.note} create={vm.create} draft={vm.draft} openLabel={vm.openLabel} fallbackHref={vm.backHref} />
        </>}
      </section>
    </div>
  </PmPage>;
}
