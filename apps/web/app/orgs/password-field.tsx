"use client";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import pf from "./password-field.module.css";

/** E2E-4P: a new password with a Show / Hide toggle (on a phone it was typed blind on /invited and /join). */
export function NewPassword({ label = "Password", value, onChange, inputClass, fieldClass }: { label?: string; value: string; onChange: (v: string) => void; inputClass: string; fieldClass: string }) {
  const [shown, setShown] = useState(false);
  return <label className={fieldClass}>{label}
    <span className={pf.wrap}>
      <input className={`${inputClass} ${pf.input}`} type={shown ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} required minLength={10}
        autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="At least 10 characters" />
      <button type="button" className={pf.toggle} onClick={() => setShown(!shown)} aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown}>
        {shown ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}</button>
    </span>
  </label>;
}
