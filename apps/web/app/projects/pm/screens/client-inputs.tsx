// PM-UI: Client inputs (PICKS 12; sheets/client-inputs.md). A client page: only the agency's client top bar (drawn here,
// identical to client-view's: mark + agency, project tile + name, from 600 px Project · Chat · Files and the contact),
// then one centred column of three cards: "We need from you" (ring + five rows, Upload on the missing ones), "Your
// journey" (a list on a phone, a row of four from 600 px of column) and "Your team". Signed in: Ahoro Mifos (client).
// Preview: /projects/pm/preview/client-inputs?state=default|upload-sheet|one-left|all-in|upload-failed
import Link from "next/link";
import { Sunrise } from "lucide-react";
import { Avatar } from "../../../avatar";
import type { ClientInputsVM } from "../contract/client-inputs";
import type { ScreenProps } from "../contract/shared";
import { PmPage, ProjectTile } from "../kit";
import ClientInputsBody from "./client-inputs-client";
import css from "./client-inputs.module.css";

/** The client top bar, the same as client-view's (same order, sizes, tile, links and breakpoints). This page is none of
 *  Project · Chat · Files, so no link is marked current. */
function ClientBar({ vm }: { vm: ClientInputsVM }) {
  const me = vm.viewer.person;
  const links = [
    { key: "project", label: "Project", href: vm.links.project },
    { key: "chat", label: "Chat", href: vm.links.chat },
    { key: "files", label: "Files", href: vm.links.files },
  ];
  return <header className={css.bar}>
    <span className={css.agency}><span className={css.agencyMark} aria-hidden="true"><Sunrise /></span><strong>{vm.agency}</strong></span>
    <span className={css.project}>
      <ProjectTile project={vm.project} size="md" />
      <h1 className={css.projectName}>{vm.project.name}</h1>
    </span>
    <nav className={css.nav} aria-label="Project pages">
      {links.map((l) => <Link key={l.key} href={l.href} className={css.navLink}>{l.label}</Link>)}
    </nav>
    <span className={css.contact}>
      <Avatar name={me.name} id={me.id} photoAt={me.photoAt} size={32} />
      <span className={css.contactName}>{me.name}</span>
    </span>
  </header>;
}

export default function ClientInputs({ vm }: ScreenProps<ClientInputsVM>) {
  return <PmPage width="full">
    <div className={css.root}>
      <ClientBar vm={vm} />
      <ClientInputsBody vm={vm} />
    </div>
  </PmPage>;
}
