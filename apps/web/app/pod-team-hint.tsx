"use client";
// DE-EA: the "unit vs function" hint in the company's own words (useWords), for server-rendered panels too.
import { Why } from "./ui";
import { useWords } from "./org-code";
import { podTeam } from "./pod-team";
export function PodTeamHint() { const t = podTeam(useWords()); return <Why detail={t.pod} more={t.team} />; }
