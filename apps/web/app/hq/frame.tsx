// PULSE-HQ: the calm canvas Pulse HQ and "What Pulse can do" sit in. Navigation is the shell's own sidebar (Pulse HQ
// and its pages), so nothing floats over the content here.
import type { ReactNode } from "react";
import css from "./hq.module.css";
import { Shortcuts } from "./shortcuts";
import { getMe } from "../lib/api";

// The shell already gives the page its one <main id="main-content">: this is a plain region inside it (a second
// <main> is an accessibility error and made every "main" lookup ambiguous).
export async function HqFrame({ children }: { children: ReactNode }) {
  const me = (await getMe()).data;
  return <div className={css.root}><div className={css.main}><div className={css.column}>{children}</div></div><Shortcuts licences={me?.orgHandle === "pulsehq"} /></div>;
}
