"use client";
import { Download, Link2, Link2Off, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { post } from "../client";
import ocss from "../orgs.module.css";
import type { Portable } from "../profile/view";
import type { Stint } from "../career/view";
import { ResumeDoc, SECTIONS, type ResumeData } from "./doc";
import css from "./resume.module.css";

export type ResumeState = { sections: string[]; shareOn: boolean; hasLink: boolean; sharedAt: string | null };

/** The resume from the account profile and the career, with only the chosen sections. */
export function buildResume(profile: Portable, career: Stint[], on: Set<string>, photo: string | null): ResumeData {
  const p = profile.profile;
  return {
    name: profile.name ?? "", headline: p.headline, pronouns: p.pronouns, location: p.location,
    photo: on.has("photo") ? photo : null,
    about: on.has("about") ? p.about : null, languages: on.has("about") ? p.languages : null,
    contact: on.has("contact") ? { email: p.contactEmail ?? null, phone: p.contactPhone ?? null } : null,
    skills: on.has("skills") ? p.skills : null, skillLevels: p.skillLevels,
    education: on.has("education") ? p.education : null, certifications: on.has("certifications") ? p.certifications : null,
    links: on.has("links") ? p.links : null,
    experience: on.has("experience") || on.has("work") ? career.filter((s) => s.kind !== "client").map((s) => ({ company: s.company, role: s.role, from: s.from, to: s.to, current: s.current,
      ...(on.has("work") ? { tasksDone: s.tasksDone ?? 0, projects: s.projects ?? 0, deliveries: s.deliveries ?? 0 } : {}) })) : null,
    highlights: on.has("highlights") ? profile.highlights.map((h) => ({ title: h.title, from: h.from, on: h.on })) : null,
    badges: on.has("badges") ? profile.badges.filter((b) => b.carried).map((b) => ({ title: b.title, from: b.from, on: b.on })) : null,
  };
}

/** The resume alone in a hidden frame (with the page's stylesheets), printed there: "Save as PDF" gets one clean
 *  document without the app around it. */
function printResume(el: HTMLElement | null) {
  if (!el) return;
  const css = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.outerHTML).join("");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>Resume</title>${css}</head><body style="margin:0;background:#fff">${el.innerHTML}</body></html>`;
  frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); window.setTimeout(() => frame.remove(), 60000); };
  document.body.appendChild(frame);
}

export function ResumeBuilder({ initial, profile, career, photo }: { initial: ResumeState; profile: Portable; career: Stint[]; photo: string | null }) {
  const [state, setState] = useState(initial);
  const [on, setOn] = useState(new Set(initial.sections));
  const [link, setLink] = useState<string | null>(null); const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const doc = useMemo(() => buildResume(profile, career, on, photo), [profile, career, on, photo]);
  const run = async (body: Record<string, unknown>, ok: string) => {
    setMsg(null);
    try { const r = await post<ResumeState & { link?: string }>("account/resume", body); setState(r); if (r.link) setLink(r.link); else if (body.share === "off") setLink(null); setMsg({ tone: "ok", text: ok }); }
    catch (e) { setMsg({ tone: "error", text: e instanceof Error ? e.message : "That did not work" }); }
  };
  const toggle = (k: string) => { const next = new Set(on); if (next.has(k)) next.delete(k); else next.add(k); setOn(next); };
  return <div className={css.builder}>
    {msg ? <p className={ocss.note} data-tone={msg.tone} role={msg.tone === "error" ? "alert" : "status"}>{msg.text}</p> : null}
    <section className={`${ocss.card} ${ocss.form}`} aria-label="Sections">
      <div className={ocss.sectionHead}><h2>Sections</h2><p>Built from your profile and your career in every company. Pay and contracts never appear.</p></div>
      <div className={css.controls}>{SECTIONS.map(([k, label]) => <label className={ocss.toggle} key={k}><input type="checkbox" checked={on.has(k)} onChange={() => toggle(k)} />{label}</label>)}</div>
      <div className={ocss.cardFoot}>
        <button type="button" className={`${ocss.btn} ${ocss.primary}`} onClick={() => printResume(sheet.current)}><Download size={15} aria-hidden="true" />Download PDF</button>
        <button type="button" className={ocss.btn} onClick={() => void run({ sections: [...on] }, "Sections saved. Your public link shows these.")}>Save sections</button>
      </div>
    </section>
    <section className={`${ocss.card} ${ocss.form}`} aria-label="Public link">
      <div className={ocss.sectionHead}><h2>Public link</h2><p>{state.shareOn ? "On: anyone with the link sees the saved sections." : "Off. Nobody outside your companies can see your resume."}</p></div>
      {link ? <p className={ocss.note} data-tone="ok"><b>Your link (shown once):</b> <a href={link} target="_blank" rel="noreferrer noopener" data-resume-link="">{link}</a></p> : null}
      <div className={ocss.cardFoot}>
        {state.shareOn ? <>
          <button type="button" className={ocss.btn} onClick={() => void run({ sections: [...on], share: "new" }, "A new link is ready; the old one stopped working.")}><RefreshCw size={15} aria-hidden="true" />New link</button>
          <button type="button" className={ocss.btn} onClick={() => void run({ share: "off" }, "Your public link is off.")}><Link2Off size={15} aria-hidden="true" />Turn off</button>
        </> : <button type="button" className={ocss.btn} onClick={() => void run({ sections: [...on], share: "new" }, "Your public link is on.")}><Link2 size={15} aria-hidden="true" />Make a public link</button>}
      </div>
    </section>
    <div ref={sheet}><ResumeDoc r={doc} /></div>
  </div>;
}
