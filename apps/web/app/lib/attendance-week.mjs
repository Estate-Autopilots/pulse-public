const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_LABELS = Object.freeze({
  present: "Present",
  leave: "Leave",
  holiday: "Holiday",
  off: "Weekly off",
  absent: "No check-in",
  today: "Not marked",
  untracked: "No data",
  upcoming: "Upcoming",
});

const TEAM_ROLES = new Set(["hr", "admin", "leadership"]);

export function canSeeTeamAttendance(role) {
  return TEAM_ROLES.has(role);
}

function dateFromIso(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new RangeError("Expected an ISO calendar date");
  const date = new Date(isoDate + "T00:00:00.000Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate) throw new RangeError("Expected an ISO calendar date");
  return date;
}

export function attendanceWeekDates(today) {
  const monday = dateFromIso(today);
  const mondayOffset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);
  return Array.from({ length: 7 }, (_, index) => new Date(monday.getTime() + index * DAY_MS).toISOString().slice(0, 10));
}

export function attendanceWeekMonths(today) {
  return [...new Set(attendanceWeekDates(today).map((date) => date.slice(0, 7)))];
}

/** Project the month endpoint into an allowlisted week payload before it reaches the view. */
export function projectAttendanceWeek(months, today, role, personId) {
  const dates = attendanceWeekDates(today);
  const base = { from: dates[0], to: dates[6], today, days: dates };
  if (!months.length || months.some((month) => month.attendanceEnabled !== true)) return { ...base, attendanceEnabled: false, people: [] };
  const dateSet = new Set(dates);
  const statusByPersonAndDate = new Map();
  const peopleById = new Map();

  for (const month of months) {
    const daysByDate = new Map(month.dates.map((cell, index) => [cell.date, index]));
    for (const person of month.people) {
      if (!peopleById.has(person.id)) peopleById.set(person.id, { id: person.id, name: person.name });
      for (const [date, dayIndex] of daysByDate) {
        if (!dateSet.has(date)) continue;
        const day = person.days[dayIndex];
        if (!day) continue;
        let byDate = statusByPersonAndDate.get(person.id);
        if (!byDate) statusByPersonAndDate.set(person.id, (byDate = new Map()));
        byDate.set(date, STATUS_LABELS[day.status] ?? "No data");
      }
    }
  }

  const people = [...peopleById.values()]
    .filter((person) => canSeeTeamAttendance(role) || person.id === personId)
    .map((person) => ({
      id: person.id,
      name: person.name,
      days: dates.map((date) => ({ date, status: statusByPersonAndDate.get(person.id)?.get(date) ?? "No data" })),
    }));

  return { ...base, attendanceEnabled: true, people };
}
