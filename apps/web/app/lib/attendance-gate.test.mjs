import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ATTENDANCE_OFF_TEXT, ATTENDANCE_OFF_TITLE, isAttendanceEnabled } from "./attendance-gate.mjs";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("attendance stays off unless the payload explicitly enables it", () => {
  assert.equal(isAttendanceEnabled({ attendanceEnabled: true }), true);
  assert.equal(isAttendanceEnabled({ attendanceEnabled: false }), false);
  assert.equal(isAttendanceEnabled({}), false);
  assert.equal(isAttendanceEnabled(null), false);
});

test("shared disabled-state copy is neutral and contains no attendance statuses", () => {
  assert.equal(ATTENDANCE_OFF_TITLE, "Attendance is off for your organisation");
  assert.equal(ATTENDANCE_OFF_TEXT, "Pulse is not recording check-ins. Leave and the other HR tools work as usual.");
  assert.doesNotMatch(`${ATTENDANCE_OFF_TITLE} ${ATTENDANCE_OFF_TEXT}`, /\b(Present|Absent|No check-in|No data)\b/);
});

test("HR attendance, week, person, and reconciliation screens branch to the shared neutral state", async () => {
  const [attendance, week, person, reconciliation, island, checkin, hrPage, off] = await Promise.all([
    source("../hr/desk/attendance.tsx"), source("../hr/desk/attendance-week.tsx"),
    source("../hr/person-tab.tsx"), source("../hr/reconciliation.tsx"), source("../notify/island.tsx"), source("./checkin-view.mjs"), source("../hr/page.tsx"), source("../hr/attendance-off.tsx"),
  ]);
  assert.match(attendance, /if \(!isAttendanceEnabled\(data\)\) return <AttendanceOff \/>;/);
  assert.match(week, /if \(week\.attendanceEnabled !== true\) return <AttendanceOff \/>;/);
  assert.match(person, /d\.attendanceEnabled === true \? <Fit[\s\S]*?: <AttendanceOff \/>/);
  assert.match(reconciliation, /if \(attendanceEnabled !== true\) return <AttendanceOff \/>;/);
  // UX-NOTIFY: Pip's menu replaced the corner companion; it offers check-in only when the shared view shows, and the
  // view never shows while attendance is off.
  // FLOAT: Pip's menu shows the day's buttons in their own row, still only when the day's control shows.
  // (The row may also wait for the top bar's check-in chip to be hidden: `&& !chipShown`.)
  assert.match(island, /\{view\.show && view\.actions\.length(?: && [^?]+)? \? <div[^>]*>\s*\{view\.actions\.map\(/);
  assert.match(checkin, /if \(!payload \|\| payload\.attendanceEnabled !== true\) return \{ show: false \};/);
  assert.match(hrPage, /attendance\.data && attendance\.data\.attendanceEnabled !== true \? <Attendance/);
  assert.match(off, /<Empty[^>]*title=\{ATTENDANCE_OFF_TITLE\} text=\{ATTENDANCE_OFF_TEXT\}/);
});
