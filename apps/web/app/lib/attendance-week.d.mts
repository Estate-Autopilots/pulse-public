export type AttendanceWeek = {
  attendanceEnabled: boolean;
  from: string;
  to: string;
  today: string;
  days: string[];
  people: { id: string; name: string; days: { date: string; status: string }[] }[];
};

export function canSeeTeamAttendance(role: string): boolean;
export function attendanceWeekDates(today: string): string[];
export function attendanceWeekMonths(today: string): string[];
export function projectAttendanceWeek(
  months: { month: string; attendanceEnabled?: boolean; dates: { date: string }[]; people: { id: string; name: string; days: { status: string }[] }[] }[],
  today: string,
  role: string,
  personId: string | null,
): AttendanceWeek;
