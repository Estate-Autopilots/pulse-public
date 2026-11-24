// PM-UI: the client's project page (sheets/client-view.md, PICKS 06 "Phase strip"). Signed in: Ahoro Mifos, the client
// contact. Only the agency's client top bar (drawn here, see ClientBar); then the one item that needs the client's OK, what we still need
// from them, their journey through the nine phases (client names), what comes next and their contact on the team.
// One column on a phone (journey as a list); from 600 px of content two columns, about 2 : 1, with the journey as one
// horizontal strip under both.
// Preview: /projects/pm/preview/client-view?state=default|changes|changes-empty|approved|nothing-waiting
import Link from "next/link";
import { Check, MessageCircle, Sunrise } from "lucide-react";
import { Avatar } from "../../../avatar";
import type { ClientViewVM } from "../contract/client-view";
import type { Phase, ScreenProps } from "../contract/shared";
import { Chip, PmButton, PmPage, ProjectTile, SectionCard, firstName, fmtDayShort } from "../kit";
import { ClientMain } from "./client-view-client";
import css from "./client-view.module.css";

type JState = "done" | "current" | "later";
const jState = (p: Phase): JState => (p.status === "done" ? "done" : p.isCurrent ? "current" : "later");

/** "Your journey": the nine phases by their client names. A list with a dot and a line on a phone; one horizontal strip
 *  of dots with the names under them from 600 px. "Done" on finished phases, "You are here" once, the date on the gate. */
function Journey({ phases }: { phases: Phase[] }) {
  return <SectionCard title="Your journey" className={css.journey}>
    <ol className={css.jList}>{phases.map((p, i) => {
      const st = jState(p);
      const next = phases[i + 1];
      return <li key={p.id} className={css.jStep} data-state={st} data-next={next ? jState(next) : undefined} aria-current={p.isCurrent ? "step" : undefined}>
        <span className={css.jDot} aria-hidden="true">{st === "done" ? <Check /> : null}</span>
        <span className={css.jName}>{p.clientName ?? p.name}</span>
        <span className={css.jTag}>
          {st === "done" ? <Chip tone="done">Done</Chip>
            : st === "current" ? <span className={css.here}>You are here</span>
              : p.isGate && p.start ? <span className={css.jDate}>{fmtDayShort(p.start)}</span> : null}
        </span>
      </li>;
    })}</ol>
  </SectionCard>;
}

/** The client top bar (sheet §2). The kit's agency bar has no project tile and no page links, so this page draws its
 *  own in the same look and order as client-inputs: agency mark + name, then the project (teal tile + name in ink, the
 *  page title), then from 600 px Project · Chat · Files, then the signed-in client (avatar; full name from 600 px). */
function ClientBar({ vm }: { vm: ClientViewVM }) {
  const me = vm.viewer.person;
  const links = [
    { key: "project", label: "Project", href: vm.links.project, current: true },
    { key: "chat", label: "Chat", href: vm.links.chat, current: false },
    { key: "files", label: "Files", href: vm.links.files, current: false },
  ];
  return <header className={css.bar}>
    <span className={css.agency}><span className={css.agencyMark} aria-hidden="true"><Sunrise /></span><strong>{vm.agency}</strong></span>
    <span className={css.project}>
      <ProjectTile project={vm.project} size="md" />
      <h1 className={css.projectName}>{vm.project.name}</h1>
    </span>
    <nav className={css.nav} aria-label="Project pages">
      {links.map((l) => <Link key={l.key} href={l.href} className={css.navLink} aria-current={l.current ? "page" : undefined}>{l.label}</Link>)}
    </nav>
    <span className={css.contact}>
      <Avatar name={me.name} id={me.id} photoAt={me.photoAt} size={32} />
      <span className={css.contactName}>{me.name}</span>
    </span>
  </header>;
}

export default function ClientView({ vm }: ScreenProps<ClientViewVM>) {
  const lead = vm.team[0];
  return <PmPage width="full">
    <div className={css.root}>
      <ClientBar vm={vm} />
      {/* No card 1 (nothing waiting, or just approved): the journey moves up into the left column so the dates and team
          on the right no longer leave a hole under a short card. */}
      <div className={css.cols} data-short={vm.review ? undefined : ""}>
        <div className={css.main}>
          <ClientMain review={vm.review} approved={vm.approved} needs={vm.needs} hue={vm.project.hue} today={vm.today} pageHref={vm.links.project}
            nothing={vm.review || vm.needs.length || vm.approved ? null : { next: vm.comingUp[0] ?? null, chat: lead ? { label: `Chat with ${firstName(lead.person)}`, href: lead.chat.href } : null }} />
        </div>

        <Journey phases={vm.journey} />

        <aside className={css.side} aria-label="Dates and team">
          <SectionCard title="Coming up">
            <ul className={css.dates}>{vm.comingUp.map((m) => <li key={m.id} className={css.date} data-goal={m.milestone ? "" : undefined}>
              <span className={css.dateLabel}>{m.label}</span>
              <span className={css.dateDay}>{fmtDayShort(m.date)}</span>
            </li>)}</ul>
          </SectionCard>
          {vm.team.length ? <SectionCard title="Your team">
            <ul className={css.team}>{vm.team.map((t) => <li key={t.person.id} className={css.member}>
              <Avatar name={t.person.name} id={t.person.id} photoAt={t.person.photoAt} size={44} />
              <span className={css.memberText}><b>{t.person.name}</b><span className={css.muted}>{t.person.role}</span></span>
              <PmButton variant="outline" href={t.chat.href} icon={MessageCircle} className={css.chat}>{t.chat.label}</PmButton>
            </li>)}</ul>
          </SectionCard> : null}
        </aside>
      </div>
    </div>
  </PmPage>;
}
