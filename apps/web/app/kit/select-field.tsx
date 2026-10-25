"use client";
// UI-POLISH (item 5): the kit's select for forms, as a drop-in for <select>. A page swaps the tag and keeps its
// <option> children and props. A press opens the kit's list (rounded rows, a tick, search when the list is long) on
// every browser, not only Chrome's customizable select. The real <select> stays underneath, invisible, and it keeps
// what a select is good at: the keyboard (arrows, typing a letter), the screen reader, `name` and `required` in a form,
// and a real change event for the page's onChange. A choice in the kit's list is written to that select and fires its
// change, so `e.target.value`, `e.currentTarget.form` and `selectOption` in tests all behave as before.
import { Children, Fragment, isValidElement, useId, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode, type SelectHTMLAttributes } from "react";
import { Combobox, type Option } from "./combobox";
import css from "./kit.module.css";

type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean; label?: string };
const text = (n: ReactNode): string => typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(text).join("")
  : isValidElement<{ children?: ReactNode }>(n) ? text(n.props.children) : "";
/** The <option>s (and <optgroup>s, and fragments) a page wrote, as the kit's options. */
function read(children: ReactNode, group?: string, out: Option<string>[] = []) {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<OptionProps & { label?: string; children?: ReactNode }>;
    if (el.type === Fragment) read(el.props.children, group, out);
    else if (el.type === "optgroup") read(el.props.children, el.props.label, out);
    else if (el.type === "option") {
      const label = el.props.label ?? text(el.props.children);
      out.push({ value: el.props.value !== undefined ? String(el.props.value) : label, label: label || "—", disabled: el.props.disabled, group });
    }
  });
  return out;
}
const setNative = (el: HTMLSelectElement, v: string) => Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, v);

export function SelectField({ children, value, defaultValue, onChange, className, disabled, size, searchable, placeholder, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  /** The kit button's size (sm: 30 px, for toolbars and table rows). */ size?: "sm" | "md"; searchable?: boolean; placeholder?: string }) {
  const real = useRef<HTMLSelectElement>(null);
  const options = read(children);
  const controlled = value !== undefined;
  const [own, setOwn] = useState(() => String(defaultValue ?? options[0]?.value ?? ""));
  const current = controlled ? String(value ?? "") : own;
  const uid = useId();
  // A multiple select has no single value to show: it stays the browser's own.
  if (rest.multiple) return <select value={value} defaultValue={defaultValue} onChange={onChange} className={className} disabled={disabled} {...rest}>{children}</select>;
  const label = rest["aria-label"] ?? rest.title ?? (typeof rest.name === "string" ? rest.name : "Choose");
  const shown = options.some((o) => o.value === current) ? current : options[0]?.value ?? "";
  return <span className={css.selectField} data-size={size} data-disabled={disabled ? "" : undefined}>
    <select ref={real} {...rest} className={`${css.selectReal}${className ? ` ${className}` : ""}`} disabled={disabled}
      {...(controlled ? { value: value ?? "" } : { defaultValue: defaultValue ?? undefined })}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => { if (!controlled) setOwn(e.target.value); onChange?.(e); }}>{children}</select>
    <Combobox id={`${uid}-kit`} shadow label={label} options={options} value={shown || null} size={size} disabled={disabled} searchable={searchable} placeholder={placeholder ?? options[0]?.label ?? "Choose"}
      focusBack={() => real.current?.focus({ preventScroll: true })}
      onChange={(v) => {
        const el = real.current; if (!el) return;
        const next = v ?? "";
        if (el.value === next) return;
        setNative(el, next);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // A controlled select is put back by React until its page takes the new value; an uncontrolled one keeps it.
        if (!controlled) setOwn(next);
      }} />
  </span>;
}
