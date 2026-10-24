"use client";
// FLOW-C: which work screen a step opens. Chosen by the step's backend module, so a company's own block of the same kind
// opens the same screen.
import { Check, Play } from "lucide-react";
import { styles } from "../ui";
import { DocScreen } from "./doc";
import { AssetScreen } from "./asset";
import { MeetingScreen } from "./meeting";
import { MediaScreen } from "./media";
import { CheckScreen, ShareScreen, VerdictScreen } from "./review";
import { SessionScreen } from "./session";
import { RecordsBoard, RequestBoard, ShootScreen } from "./boards";
import { DailyUpdate } from "./daily";
import { AssignScreen, CollectScreen, IntakeScreen, MessageScreen, MoneyScreen, SlotScreen, WaitScreen } from "./collect";
import { CalendarScreen, DriveFileScreen, DriveFolderScreen, WebhookScreen } from "./apps";
import type { Work } from "./work";
import type { Screen } from "./types";
import css from "./work.module.css";

export function Surface({ screen, w }: { screen: Screen; w: Work }) {
  switch (screen) {
    case "doc": return <DocScreen w={w} />;
    case "asset": return <AssetScreen w={w} />;
    case "meeting": return <MeetingScreen w={w} />;
    case "review": return <ShareScreen w={w} />;
    case "verdict": return <VerdictScreen w={w} />;
    case "check": return <CheckScreen w={w} />;
    case "media": return <MediaScreen w={w} />;
    case "session": return <SessionScreen w={w} />;
    case "requests": return <RequestBoard w={w} />;
    case "shoot": return <ShootScreen w={w} />;
    case "records": return <RecordsBoard w={w} />;
    case "collect": return <CollectScreen w={w} form={w.form} />;
    case "intake": return <IntakeScreen w={w} />;
    case "money": return <MoneyScreen w={w} />;
    case "slot": return <SlotScreen w={w} />;
    case "message": return <MessageScreen w={w} />;
    case "assign": return <AssignScreen w={w} holders={w.holders} />;
    case "wait": return <WaitScreen w={w} />;
    case "calendar": return <CalendarScreen w={w} />;
    case "drive_folder": return <DriveFolderScreen w={w} />;
    case "drive_file": return <DriveFileScreen w={w} />;
    case "webhook": return <WebhookScreen w={w} />;
    case "daily": return <><DailyUpdate /><TaskScreen w={w} /></>;
    default: return <TaskScreen w={w} />;
  }
}

/** A step that is a to-do: its checklist (beside the work) and Done. */
export function TaskScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, m = d.module;
  return <div className={css.task}>
    <p className={css.what}>{m.summary}</p>
    {w.live ? <div className={css.actions}>
      {s.state === "open" ? <button type="button" className={styles.btn} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/move`, { to: "in_progress" }, "Started")}><Play size={14} aria-hidden="true" />Start</button> : null}
      {m.finish !== "auto" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/finish`, {}, "Done: whatever waited on it opens")}><Check size={14} aria-hidden="true" />Done</button> : null}
    </div> : null}
    {s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Done; the steps that waited on it have opened.</p> : null}
  </div>;
}
