// PEOPLE-CONTACTS (owner, 11 Oct 2026): one profile header for people and contacts: the photo (changed in place with
// the cropper), the name with its status, one line of who they are, a row of facts as quiet chips (pod, manager,
// joined, place; or type, client, city for a contact) and the actions. On a phone it stacks under a soft cover; on a
// computer it stays compact so the record below keeps the window.
import Link from "next/link";
import type { ReactNode } from "react";
import { Avatar, hueStyle } from "./ui";
import css from "./profile-header.module.css";

export type Chip = { icon?: ReactNode; label?: string; value: ReactNode; href?: string; title?: string };

export function ProfileHeader({ name, id, photoAt, square, picker, badges, subtitle, chips, actions, back }: {
  name: string; id: string; photoAt?: string | null; square?: boolean; picker?: ReactNode; badges?: ReactNode; subtitle?: ReactNode;
  chips?: (Chip | null | false | undefined)[]; actions?: ReactNode; back?: { href: string; label: string };
}) {
  const shown = (chips ?? []).filter((c): c is Chip => !!c);
  return (
    <section className={css.header} style={hueStyle(name)} aria-label={name} data-profile-header="">
      <div className={css.cover} aria-hidden="true" />
      {back ? <Link href={back.href} className={css.back}>{back.label}</Link> : null}
      <div className={css.body}>
        <span className={css.photo}>
          <Avatar name={name} id={id} photoAt={photoAt} size={88} shape={square ? "square" : undefined} className={css.avatar} />
          {picker}
        </span>
        <div className={css.text}>
          <h2 className={css.name}><span>{name}</span>{badges}</h2>
          {subtitle ? <p className={css.subtitle}>{subtitle}</p> : null}
          {shown.length ? <ul className={css.chips}>{shown.map((c, i) => {
            const inner = <>{c.icon}{c.label ? <span className={css.chipLabel}>{c.label}</span> : null}<b>{c.value}</b></>;
            return <li key={i} title={c.title}>{c.href ? <Link href={c.href} className={css.chip}>{inner}</Link> : <span className={css.chip}>{inner}</span>}</li>;
          })}</ul> : null}
        </div>
        {actions ? <div className={css.actions}>{actions}</div> : null}
      </div>
    </section>
  );
}
