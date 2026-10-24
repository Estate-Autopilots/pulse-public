import { CalendarOff } from "lucide-react";
import { Empty, styles } from "../ui";
import { ATTENDANCE_OFF_TEXT, ATTENDANCE_OFF_TITLE } from "../lib/attendance-gate.mjs";
export { isAttendanceEnabled } from "../lib/attendance-gate.mjs";

export function AttendanceOff() {
  return <section className={styles.panel}><Empty icon={CalendarOff} first title={ATTENDANCE_OFF_TITLE} text={ATTENDANCE_OFF_TEXT} /></section>;
}
