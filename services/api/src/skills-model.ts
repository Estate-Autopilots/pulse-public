// R48: the internal CV as Markdown, from the snapshot the person reviewed (pulse.resume_build in 0360). Pure: no
// database, so the export and its tests read the same text. It says what is self-assessed and what someone verified,
// which work is approved, which skills are local names, the scale used and each taxonomy's attribution.

export type CvSkill = { label: string; family: string; code: string; local: boolean; level: number; levelLabel: string | null; since: string | null;
  lastUsed: string | null; verified: { level: number; levelLabel: string | null; by: string; basis: string; at: string } | null;
  approvedWork: string[]; claimedWork: number };
export type CvExperience = { title: string; project: string | null; started: string; ended: string | null; responsibilities: string | null;
  outcomes: string | null; confirmed: { by: string; basis: string } | null };
export type CvBody = { person: { name: string; role: string | null; team: string | null; pod: string | null; joined: string | null };
  headline: string | null; summary: string | null; skills: CvSkill[]; experience: CvExperience[];
  scale: { confirmed: boolean; levels: { level: number; label: string; description: string }[] }; attribution: string[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2025-04" → "Apr 2025". */
export const month = (m: string | null | undefined) => m && /^\d{4}-\d{2}/.test(m) ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "";
const BASIS: Record<string, string> = { manager: "manager", hr: "HR" };
const FAMILY: Record<string, string> = { esco: "ESCO", onet: "O*NET", local: "local skill" };
/** Markdown control characters in text people typed are shown as written, not as formatting. */
const md = (s: string | null | undefined) => String(s ?? "").replace(/[\\`*_[\]#<>|]/g, (c) => `\\${c}`).replace(/\r?\n+/g, " ").trim();

export function cvMarkdown(b: CvBody, meta: { version: number; reviewedAt: string; company: string }): string {
  const out: string[] = [];
  const p = b.person;
  out.push(`# ${md(p.name)}`, "");
  const line = [p.role, p.team, p.pod ? (/^pod\b/i.test(p.pod) ? p.pod : `Pod ${p.pod}`) : null].filter(Boolean).map(md).join(" · ");
  if (line) out.push(line, "");
  if (b.headline) out.push(`**${md(b.headline)}**`, "");
  if (b.summary) out.push(md(b.summary), "");
  if (b.skills.length) {
    out.push("## Skills", "");
    for (const s of b.skills) {
      const when = [s.since ? `since ${month(s.since)}` : null, s.lastUsed ? `last used ${month(s.lastUsed)}` : "in use now"].filter(Boolean).join(", ");
      const mark = s.verified ? `verified ${s.verified.levelLabel ?? `level ${s.verified.level}`} by ${md(s.verified.by)} (${BASIS[s.verified.basis] ?? s.verified.basis}, ${s.verified.at})`
        : "not verified yet";
      out.push(`- **${md(s.label)}** (${FAMILY[s.family] ?? s.family}): ${s.levelLabel ?? `level ${s.level}`}, self-assessed; ${mark}; ${when}`);
      if (s.approvedWork.length) out.push(`  - Approved work: ${s.approvedWork.map(md).join("; ")}`);
      if (s.claimedWork) out.push(`  - ${s.claimedWork} more piece${s.claimedWork === 1 ? "" : "s"} of work linked, not yet approved`);
    }
    out.push("");
  }
  if (b.experience.length) {
    out.push("## Experience at " + md(meta.company), "");
    for (const e of b.experience) {
      out.push(`### ${md(e.title)}${e.project ? ` · ${md(e.project)}` : ""}`, "");
      out.push(`${month(e.started)} – ${e.ended ? month(e.ended) : "now"} · ${e.confirmed ? `confirmed by ${md(e.confirmed.by)} (${BASIS[e.confirmed.basis] ?? e.confirmed.basis})` : "self-reported"}`, "");
      if (e.responsibilities) out.push(`Responsibilities: ${md(e.responsibilities)}`, "");
      if (e.outcomes) out.push(`Outcomes: ${md(e.outcomes)}`, "");
    }
  }
  out.push("---", "");
  out.push(`Proficiency scale (${b.scale.confirmed ? "confirmed by HR" : "Pulse's starting scale, not yet confirmed by HR"}): ` +
    b.scale.levels.map((l) => `${l.level} ${md(l.label)}`).join(", ") + ".", "");
  out.push(`Reviewed by ${md(p.name)} on ${meta.reviewedAt.slice(0, 10)} (version ${meta.version}). Internal to ${md(meta.company)}.`, "");
  for (const a of b.attribution) out.push(md(a), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** A file name from the person's name: letters, digits and dashes. */
export const cvFileName = (name: string, version: number) =>
  `cv-${name.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s_]+/g, "-").slice(0, 60) || "person"}-v${version}.md`;
