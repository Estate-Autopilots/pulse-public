'use client';
import { useEffect, useId, useRef, useState, type ChangeEventHandler } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import css from './login.module.css';

type Props = {
  label: string; name: string; autoComplete: string; required?: boolean; maxLength?: number;
  value?: string; onChange?: ChangeEventHandler<HTMLInputElement>;
};

/** A masked-by-default password field. Submitting its form hides the value again. */
export function PasswordField({ label, name, autoComplete, required, maxLength, value, onChange }: Props) {
  const id = useId(), input = useRef<HTMLInputElement>(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const mask = () => setVisible(false);
    form.addEventListener('submit', mask);
    return () => form.removeEventListener('submit', mask);
  }, []);
  return <div className={css.passwordField}>
    <label className={css.passwordLabel} htmlFor={id}>{label}</label>
    <span className={css.passwordControl}>
      <input ref={input} className={css.passwordInput} id={id} name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete}
        required={required} maxLength={maxLength} value={value} onChange={onChange} />
      <button className={css.passwordToggle} type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}
        aria-controls={id} title={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible((shown) => !shown)}>
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        <span>{visible ? 'Hide' : 'Show'}</span>
      </button>
    </span>
  </div>;
}
