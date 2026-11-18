"use client";
// PROFILE-3: the person at a glance in the game kit's tiles. A client part, because the tiles take their icon as a
// component, and a server page cannot hand a function to a client component.
import { CalendarDays, ListChecks, Network, Sparkles } from "lucide-react";
import { StatTile, StatTiles } from "../kit/game";

export function PersonGlance({ first, since, openTasks, tasksHref, skills, reports }: {
  first: string; /** "1 yr 9 mo", or null when the joining date is not known. */ since: string | null;
  /** Null when the viewer may not see their work. */ openTasks: number | null; tasksHref: string; skills: number; reports: number }) {
  return <StatTiles label={`${first} at a glance`} min={150}>
    <StatTile label="Time here" value={since ?? "Not set"} icon={CalendarDays} />
    {openTasks !== null ? <StatTile label="Open tasks" value={openTasks} icon={ListChecks} href={tasksHref} /> : null}
    <StatTile label="Skills" value={skills} icon={Sparkles} />
    <StatTile label="Direct reports" value={reports} icon={Network} />
  </StatTiles>;
}
