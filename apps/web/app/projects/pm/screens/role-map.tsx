// PM-UI 17: the role map (sheets/role-map.md, PICKS 17 "one role table card"). Back link, the project header, the five
// project tabs with Team selected, then ONE "Team" card: six roles, one person each, a chevron per row that opens the
// person menu (inline on a phone, a popover from 600 px of content width), a note on what moves, and "Save team".
// Preview: /projects/pm/preview/role-map?state=default|picked-ira|closed|saved
import Link from "next/link";
import type { RoleMapVM } from "../contract/role-map";
import type { ScreenProps } from "../contract/shared";
import { BackLink, HealthChip, PmPage, ProjectTile } from "../kit";
import { RoleTable } from "./role-map-client";
import css from "./role-map.module.css";

export default function RoleMap({ vm }: ScreenProps<RoleMapVM>) {
  const p = vm.project;
  return <PmPage>
    <div className={css.root}>
      <BackLink href={vm.backHref} label="Projects" />

      <header className={css.head}>
        <ProjectTile project={p} size="lg" />
        <div className={css.headText}>
          <h1 className={css.name}>{p.name}</h1>
          <HealthChip health={p.health} />
        </div>
      </header>

      <nav className={css.tabs} aria-label="Project">
        {vm.tabs.map((t) => <Link key={t.key} href={t.href} className={css.tab} aria-current={t.key === "team" ? "page" : undefined}>{t.label}</Link>)}
      </nav>

      <RoleTable vm={vm} />
    </div>
  </PmPage>;
}
