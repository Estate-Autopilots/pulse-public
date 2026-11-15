/**
 * Admin's kit: the console kit (app/ui/sx, ported from the Sales X-Ray admin), with Next's Link for
 * the pieces that link. Screens import from here as before:
 *
 *   import { Panel, Kpi, Tiles, InlineEdit } from "@/app/ui/kit";
 */
import * as Kit from "./sx";
import Link from "next/link";
import type { ComponentProps } from "react";

export {
  cx,
  Badge,
  Delta,
  Spark,
  Tiles,
  Meter,
  Why,
  Fact,
  Skeleton,
  hue,
  initials,
  List,
  Table,
  Card,
  Button,
  Field,
  Page,
  Unavailable,
  Kbd,
  Toolbar,
  kitStyles,
  type Tone,
} from "./sx";

export function PageHeader(props: ComponentProps<typeof Kit.PageHeader>) {
  return <Kit.PageHeader link={Link} {...props} />;
}

export function Panel(props: ComponentProps<typeof Kit.Panel>) {
  return <Kit.Panel link={Link} {...props} />;
}

export function Kpi(props: ComponentProps<typeof Kit.Kpi>) {
  return <Kit.Kpi link={Link} {...props} />;
}

export function Empty(props: ComponentProps<typeof Kit.Empty>) {
  return <Kit.Empty link={Link} {...props} />;
}

export function QueryTabs(props: ComponentProps<typeof Kit.QueryTabs>) {
  return <Kit.QueryTabs link={Link} {...props} />;
}

export function Row(props: ComponentProps<typeof Kit.Row>) {
  return <Kit.Row link={Link} {...props} />;
}
