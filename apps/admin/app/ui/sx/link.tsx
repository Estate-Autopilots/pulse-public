import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";

/** What the kit asks of a router link: Next's Link fits, and so does an anchor. */
export type KitLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  href: string;
  scroll?: boolean;
  children?: ReactNode;
};

export type KitLink = ComponentType<KitLinkProps>;

/** The fallback when an app passes no router link: a plain anchor. */
export function Anchor({ href, scroll, children, ...rest }: KitLinkProps) {
  void scroll;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
