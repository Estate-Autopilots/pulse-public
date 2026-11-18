export const ATTENDANCE_OFF_TITLE = "Attendance is off for your organisation";
export const ATTENDANCE_OFF_TEXT = "Pulse is not recording check-ins. Leave and the other HR tools work as usual.";

export function isAttendanceEnabled(payload) {
  return payload?.attendanceEnabled === true;
}
