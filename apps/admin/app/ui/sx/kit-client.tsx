"use client";

/** The interactive pieces of the kit (state or event handlers). */
import { Pencil } from "./icons";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { hue, initials } from "./kit";
import styles from "./kit.module.css";

/** A second level of choice, drawn as a segmented control. */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { key: T; label: ReactNode }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={styles.segment}
          aria-pressed={item.key === value}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A photo, or initials on a tint that stays the same for the same name. */
export function Avatar({
  name,
  photoUrl,
  size = 24,
  shape,
}: {
  name: string;
  photoUrl?: string | null;
  size?: number;
  shape?: "square";
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={styles.avatar}
      data-shape={shape}
      style={{ "--size": `${size}px`, "--hue": hue(name) } as CSSProperties}
      aria-hidden="true"
    >
      {photoUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- Private, session-bound images; already sized.
        <img
          src={photoUrl}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/**
 * Click (or Enter) to edit in place. Enter or leaving the box saves, Escape
 * keeps the old value. A failed save keeps the draft and says why; nothing
 * changes on screen until `onSave` resolves.
 */
export function InlineEdit({
  value,
  onSave,
  label,
  placeholder = "Add",
  maxLength,
  disabled = false,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  label: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Set while the box closes, so a blur from closing never saves (or re-saves).
  const closing = useRef(false);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const start = () => {
    if (disabled) return;
    closing.current = false;
    setDraft(value);
    setState("idle");
    setError("");
    setEditing(true);
  };
  const stop = () => {
    closing.current = true;
    setEditing(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const commit = async () => {
    if (state === "saving" || closing.current) return;
    const next = draft.trim();
    if (next === value.trim()) {
      stop();
      return;
    }
    setState("saving");
    setError("");
    try {
      await onSave(next);
      setState("idle");
      stop();
    } catch (reason) {
      setState("error");
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : "Not saved. Try again.",
      );
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closing.current = true;
      setDraft(value);
      setState("idle");
      setError("");
      stop();
    }
  };

  if (!editing)
    return (
      <button
        ref={trigger}
        type="button"
        className={styles.inline}
        onClick={start}
        disabled={disabled}
        aria-label={`${label}: ${value || placeholder}. Edit`}
      >
        <span className={value ? undefined : styles.muted}>
          {value || placeholder}
        </span>
        {disabled ? null : <Pencil size={12} aria-hidden="true" />}
      </button>
    );
  return (
    <span className={styles.inlineEditing}>
      <input
        ref={input}
        className={styles.inlineInput}
        value={draft}
        maxLength={maxLength}
        aria-label={label}
        aria-invalid={state === "error" || undefined}
        disabled={state === "saving"}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKey}
        onBlur={() => void commit()}
      />
      <small
        className={state === "error" ? styles.fieldError : styles.fieldHint}
        role={state === "error" ? "alert" : "status"}
      >
        {state === "saving" ? "Saving…" : error}
      </small>
    </span>
  );
}
