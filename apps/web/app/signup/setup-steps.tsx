"use client";
// SELF-SERVE (owner, 4 Nov 2026): the two questions a new space starts from, on the sign-up page and on Start another
// space: "Which describes you?" (several at once) and "What will you use Pulse for?" (a personal space or an
// organisation: its name and what it calls the people it serves). Chips and striped cards as on My day.
import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import { PROFILES, SERVED, SPACES, type ProfileKey, type SetupAnswers, type SpaceKey } from "./setup-catalogue";
import css from "./setup.module.css";

const hue = (h: number) => ({ "--space-hue": h }) as CSSProperties;

export function WhoStep({ answers, onChange }: { answers: SetupAnswers; onChange: (a: SetupAnswers) => void }) {
  const toggle = (k: ProfileKey) => onChange({ ...answers, profiles: answers.profiles.includes(k) ? answers.profiles.filter((x) => x !== k) : [...answers.profiles, k] });
  return <fieldset className={css.group}>
    <legend className={css.legend}>Which describes you? <small>Choose all that fit. You can change this later.</small></legend>
    <div className={css.chips}>{PROFILES.map((p) => {
      const on = answers.profiles.includes(p.key);
      return <button key={p.key} type="button" className={css.chip} aria-pressed={on} onClick={() => toggle(p.key)}>
        <span className={css.tick} aria-hidden="true">{on ? <Check size={14} /> : null}</span>
        <span className={css.chipText}><b>{p.label}</b><small>{p.hint}</small></span>
      </button>;
    })}</div>
  </fieldset>;
}

export function UseStep({ answers, onChange, personName }: { answers: SetupAnswers; onChange: (a: SetupAnswers) => void; personName?: string }) {
  const pick = (k: SpaceKey) => {
    const s = SPACES.find((x) => x.key === k)!;
    const served = s.served === "clients" && answers.profiles.includes("professional") && k === "practice" ? "clients" : s.served;
    const suggested = !answers.orgName && k === "practice" && personName?.trim() ? `${personName.trim()} Practice` : answers.orgName;
    onChange({ ...answers, space: k, served, orgName: suggested });
  };
  const space = SPACES.find((x) => x.key === answers.space);
  const onlyEmployee = answers.profiles.length === 1 && answers.profiles[0] === "employee";
  return <>
    <fieldset className={css.group}>
      <legend className={css.legend}>What will you use Pulse for? <small>You can start more spaces later; each has its own settings.</small></legend>
      <div className={css.cards} role="radiogroup" aria-label="What you will use Pulse for">{SPACES.map((s, i) => {
        const on = answers.space === s.key;
        return <button key={s.key} type="button" role="radio" aria-checked={on} className={css.card} style={hue(s.hue)} onClick={() => pick(s.key)}>
          <span className={css.no} aria-hidden="true">{on ? <Check size={14} /> : i + 1}</span>
          <span className={css.cardText}><b>{s.label}</b><small>{s.hint}</small></span>
        </button>;
      })}</div>
    </fieldset>
    {onlyEmployee && answers.space === "personal" ? <p className={css.tip}>Is your company already on Pulse? Open the invitation link it sent you to join it. This space stays your own.</p> : null}
    {space && space.named ? <div className={css.more} style={hue(space.hue)}>
      <label className={css.field}>{space.key === "practice" ? "Your practice’s name" : "Your organisation’s name"}
        <input name="orgName" required minLength={2} maxLength={80} autoComplete="organization" value={answers.orgName}
          placeholder={space.key === "practice" ? "Dr. Asha Rao Clinic" : "Name it as your clients know it"} onChange={(e) => onChange({ ...answers, orgName: e.target.value })} /></label>
      <fieldset className={css.group}>
        <legend className={css.legend}>What do you call the people you serve?</legend>
        <div className={css.chips} data-small="">{SERVED.map((w) => <button key={w.key} type="button" className={css.chip} aria-pressed={answers.served === w.key}
          onClick={() => onChange({ ...answers, served: w.key })}><span className={css.chipText}><b>{w.label}</b></span></button>)}</div>
      </fieldset>
    </div> : null}
  </>;
}

/** A plain-words line of what the answers will set up (shown before the last step). */
export function setupSummary(a: SetupAnswers): string {
  const s = SPACES.find((x) => x.key === a.space);
  if (!s) return "";
  if (s.key === "personal") return "Your own space with starter plans for you. Start an organisation any time.";
  const word = SERVED.find((w) => w.key === a.served)?.label.toLowerCase() ?? "clients";
  return `${a.orgName.trim() || "Your organisation"}: ${word}, a starter project and your first steps on its home page. Change any of it in Settings.`;
}

export function answersReady(step: "who" | "use", a: SetupAnswers): string | null {
  if (step === "who") return a.profiles.length ? null : "Choose at least one that describes you.";
  const s = SPACES.find((x) => x.key === a.space);
  if (!s) return "Choose what you will use Pulse for.";
  if (s.named && a.orgName.trim().length < 2) return s.key === "practice" ? "Give your practice a name." : "Give your organisation a name.";
  return null;
}
