"use client";

/**
 * Ctrl+K / Cmd+K: jump to any section by typing, or paste a call id to open
 * that call. Arrow keys move, Enter opens, Escape closes and returns focus.
 */
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import type { NavGroup } from "../lib/nav";
import styles from "./command-menu.module.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Entry = { key: string; label: string; hint: string; href: string };

export function commandEntries(
  groups: readonly NavGroup[],
  query: string,
): Entry[] {
  const text = query.trim().toLowerCase();
  const entries: Entry[] = [];
  if (UUID.test(text))
    entries.push({
      key: `call:${text}`,
      label: `Open call ${text.slice(0, 8)}…`,
      hint: "Call review",
      href: `/calls/${text}`,
    });
  for (const group of groups)
    for (const item of group.items)
      if (
        !text ||
        item.label.toLowerCase().includes(text) ||
        group.label.toLowerCase().includes(text)
      )
        entries.push({
          key: item.href,
          label: item.label,
          hint: group.label || "Admin",
          href: item.href,
        });
  return entries;
}

export function CommandMenu({ groups }: { groups: readonly NavGroup[] }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const entries = useMemo(() => commandEntries(groups, query), [groups, query]);

  const open = () => {
    setQuery("");
    setIndex(0);
    dialog.current?.showModal();
    requestAnimationFrame(() => input.current?.focus());
  };
  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    dialog.current?.close();
    router.push(entry.href);
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else open();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={open}
        aria-label="Go to a section or call"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <Search size={14} aria-hidden="true" />
        <span>Go to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-label="Go to a section or call"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className={styles.searchRow}>
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            className={styles.input}
            value={query}
            placeholder="Type a section, or paste a call id"
            aria-label="Go to"
            aria-controls="command-results"
            aria-activedescendant={
              entries[index] ? `command-${index}` : undefined
            }
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => Math.min(entries.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(entries[index]);
              }
            }}
          />
        </div>
        <ul
          id="command-results"
          className={styles.results}
          role="listbox"
          aria-label="Results"
        >
          {entries.length === 0 ? (
            <li className={styles.none}>No section matches “{query}”.</li>
          ) : null}
          {entries.map((entry, position) => (
            <li
              key={entry.key}
              id={`command-${position}`}
              role="option"
              aria-selected={position === index}
              className={styles.result}
              onMouseEnter={() => setIndex(position)}
              onClick={() => go(entry)}
            >
              <span>{entry.label}</span>
              <small>{entry.hint}</small>
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
