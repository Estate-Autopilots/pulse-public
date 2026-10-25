import test from "node:test";
import assert from "node:assert/strict";
import { attendanceWeekDates, attendanceWeekMonths, canSeeTeamAttendance, projectAttendanceWeek } from "./attendance-week.mjs";

const monthFixture = (month, people) => {
  const parts = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
  const dates = Array.from({ length: lastDay }, (_, index) => ({ date: month + "-" + String(index + 1).padStart(2, "0") }));
  return { month, attendanceEnabled: true, dates, people: people.map((person) => ({
    id: person.id,
    name: person.name,
    days: dates.map((cell) => person.statuses[cell.date] ?? { status: "untracked" }),
  })) };
};

const fixtures = () => [
  monthFixture("2026-10", [
    { id: "person-ada", name: "Ada Example", statuses: { "2026-10-26": { status: "present", in: "09:01", worked: 485, mode: "office" }, "2026-10-27": { status: "leave", half: true } } },
    { id: "person-bea", name: "Bea Example", statuses: { "2026-10-26": { status: "absent", late: 12, worked: 0 } } },
    { id: "person-sam", name: "Sam Example", statuses: { "2026-10-26": { status: "present", worked: 420 } } },
  ]),
  monthFixture("2026-11", [
    { id: "person-ada", name: "Ada Example", statuses: { "2026-11-01": { status: "off", open: false } } },
    { id: "person-bea", name: "Bea Example", statuses: { "2026-11-01": { status: "holiday", out: "17:00" } } },
    { id: "person-sam", name: "Sam Example", statuses: { "2026-11-01": { status: "off" } } },
  ]),
];

test("builds a Monday-to-Sunday week across a month boundary", () => {
  assert.deepEqual(attendanceWeekDates("2026-11-01"), [
    "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01",
  ]);
  assert.deepEqual(attendanceWeekMonths("2026-11-01"), ["2026-10", "2026-11"]);
});

test("projects exactly one daily status and strips timing and minute fields", () => {
  const week = projectAttendanceWeek(fixtures(), "2026-11-01", "hr", null);
  assert.equal(week.people.length, 3);
  assert.deepEqual(week.people[0].days.slice(0, 3), [
    { date: "2026-10-26", status: "Present" },
    { date: "2026-10-27", status: "Leave" },
    { date: "2026-10-28", status: "No data" },
  ]);
  assert.deepEqual(Object.keys(week.people[0]).sort(), ["days", "id", "name"]);
  assert.deepEqual(Object.keys(week.people[0].days[0]).sort(), ["date", "status"]);
  assert.equal(JSON.stringify(week).includes("09:01"), false);
  assert.equal(JSON.stringify(week).includes("worked"), false);
  assert.equal(JSON.stringify(week).includes("late"), false);
});

test("allows API-authorized roles to see the team week and scopes other roles to themselves", () => {
  const people = fixtures();
  const allPeople = ["person-ada", "person-bea", "person-sam"];
  for (const role of ["hr", "admin", "leadership"]) {
    assert.equal(canSeeTeamAttendance(role), true);
    assert.deepEqual(projectAttendanceWeek(people, "2026-11-01", role, null).people.map((person) => person.id), allPeople);
  }
  assert.equal(canSeeTeamAttendance("manager"), false);
  assert.deepEqual(projectAttendanceWeek(people, "2026-11-01", "manager", "person-sam").people.map((person) => person.id), ["person-sam"]);
  assert.deepEqual(projectAttendanceWeek(people, "2026-11-01", "member", "person-bea").people.map((person) => person.id), ["person-bea"]);
});

test("treats false and missing organisation flags as off without projecting statuses", () => {
  for (const months of [
    fixtures().map((month) => ({ ...month, attendanceEnabled: false })),
    fixtures().map(({ attendanceEnabled, ...month }) => month),
  ]) {
    const week = projectAttendanceWeek(months, "2026-11-01", "hr", null);
    assert.equal(week.attendanceEnabled, false);
    assert.deepEqual(week.people, []);
    assert.equal(JSON.stringify(week).includes("Present"), false);
    assert.equal(JSON.stringify(week).includes("No check-in"), false);
    assert.equal(JSON.stringify(week).includes("No data"), false);
  }
});

test("rejects a malformed date instead of rendering a misleading week", () => {
  assert.throws(() => attendanceWeekDates("not-a-date"), RangeError);
});
