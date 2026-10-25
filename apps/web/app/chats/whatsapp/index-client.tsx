"use client";
// WA-IMPORT: the imported chats list with a title search (the server filters; typing waits a moment).
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { WaList, type WaRow } from "./wa";
import css from "./wa.module.css";

export function WaIndex({ rows, total, q, filtered }: { rows: WaRow[]; total: number; q: string; filtered: boolean }) {
  const router = useRouter(), params = useSearchParams(), [words, setWords] = useState(q);
  useEffect(() => {
    if (words === q) return;
    const t = setTimeout(() => { const p = new URLSearchParams(params.toString()); if (words.trim()) p.set("q", words.trim()); else p.delete("q"); router.replace(`/chats/whatsapp?${p.toString()}`); }, 350);
    return () => clearTimeout(t);
  }, [words, q, params, router]);
  return <div className={css.index}>
    <div className={css.filters}>
      <label className={css.search}><Search size={15} aria-hidden="true" /><input value={words} onChange={(e) => setWords(e.target.value)} placeholder="Search chat names" aria-label="Search chat names" /></label>
      {filtered ? <Link href="/chats/whatsapp">Show every chat</Link> : null}
      {rows.length < total ? <small>Showing {rows.length} of {total}</small> : null}
    </div>
    <WaList rows={rows} />
  </div>;
}
