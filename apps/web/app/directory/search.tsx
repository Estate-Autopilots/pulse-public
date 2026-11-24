"use client";
// COMPANY-SEARCH: the live search of "Find companies and people" (results as you type; the address keeps ?q= and ?tab=).
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AtSign, BadgeCheck, Building2, Languages, Loader2, Search, UserRound, X } from "lucide-react";
import { EmptyState, ProgressRing } from "../kit/game";
import { initials, matchWords, searchable, searchCompanies, searchPeople, type DirectoryCompany, type DirectoryPerson } from "../lib/directory.mjs";
import { CompanyLine } from "./company-picker";
import css from "./directory.module.css";

type Tab = "companies" | "people";
/** FIX-SHELL: the company's own public card on Vitals (admins), for "Your company on Vitals". */
export type OwnCard = { name: string; handle: string | null; card: { listed?: boolean; legalName?: string | null; city?: string | null; industry?: string | null; website?: string | null; gstin?: string | null; cin?: string | null } };
type State = { q: string; tab: Tab; companies?: DirectoryCompany[]; people?: DirectoryPerson[]; error?: string } | null;

export function PersonAvatar({ person, size = 40 }: { person: Pick<DirectoryPerson, "name" | "photo">; size?: number }) {
  const [failed, setFailed] = useState(false);
  // eslint-disable-next-line @next/next/no-img-element -- a small same-origin picture from the API, versioned in its address
  return person.photo && !failed ? <img src={person.photo} alt="" width={size} height={size} className={css.avatar} style={{ width: size, height: size }} onError={() => setFailed(true)} />
    : <span className={css.avatar} style={{ width: size, height: size }} aria-hidden="true">{initials(person.name)}</span>;
}

export function DirectorySearch({ initialQ, initialTab, own }: { initialQ: string; initialTab: Tab; own?: OwnCard | null }) {
  const [q, setQ] = useState(initialQ);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [state, setState] = useState<State>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (q.trim()) url.searchParams.set("q", q.trim()); else url.searchParams.delete("q");
    if (tab === "people") url.searchParams.set("tab", "people"); else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url);
    if (!searchable(q)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const ask = tab === "people" ? searchPeople(q, { signal: abort.signal, limit: 20 }).then((people) => ({ q, tab, people }))
        : searchCompanies(q, { signal: abort.signal, limit: 20 }).then((companies) => ({ q, tab, companies }));
      ask.then((s) => { if (!abort.signal.aborted) setState(s); })
        .catch((e: Error) => { if (!abort.signal.aborted && e.name !== "AbortError") setState({ q, tab, error: e.message }); });
    }, 150);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [q, tab]);

  // Loading is read from the last answer: it was for another question or the other tab.
  const loading = searchable(q) && !(state && state.q === q && state.tab === tab);
  const fresh = state && state.tab === tab;
  return <div className={css.page}>
    <section className={css.searchPanel} aria-label="Search">
      <div className={css.tabs} role="tablist" aria-label="What to find">
        <button type="button" role="tab" className={css.tab} aria-selected={tab === "companies"} onClick={() => setTab("companies")}><Building2 size={16} aria-hidden="true" />Companies</button>
        <button type="button" role="tab" className={css.tab} aria-selected={tab === "people"} onClick={() => setTab("people")}><UserRound size={16} aria-hidden="true" />People</button>
      </div>
      <label className={css.srOnly} htmlFor="directory-q">Search</label>
      <div className={`${css.box} ${css.heroBox}`}>
        <Search size={20} className={css.boxIcon} aria-hidden="true" />
        <input ref={input} id="directory-q" className={css.input} type="search" inputMode="search" autoComplete="off" spellCheck={false} autoFocus
          placeholder={tab === "people" ? "Name or @handle" : "Name, @handle, GSTIN or CIN"} value={q} onChange={(e) => setQ(e.target.value)} />
        {loading ? <Loader2 size={18} className={css.spin} aria-hidden="true" /> : q ? <button type="button" className={css.clear} aria-label="Clear" onClick={() => { setQ(""); input.current?.focus(); }}><X size={18} /></button> : null}
      </div>
      <p className={css.note}>{tab === "people" ? "Only people who chose “Let people find me” show here. You can choose it in Settings → Your account."
        : "Every company on Vitals shows its name, @handle, logo and city. It chooses what else to show."}</p>
    </section>
    <div role="tabpanel" aria-live="polite" aria-busy={loading}>
      {!searchable(q) ? <Start tab={tab} own={own} />
        : !fresh ? <div className={css.grid}>{[0, 1, 2].map((i) => <div key={i} className={css.skeleton} />)}</div>
        : state!.error ? <div className={css.empty} role="alert"><b>{state!.error}</b></div>
        : tab === "companies" ? <Companies rows={state!.companies ?? []} q={state!.q} />
        : <People rows={state!.people ?? []} q={state!.q} />}
    </div>
  </div>;
}

/** Before anything is typed: the company's own place on Vitals (admins) and what can be searched for. */
function Start({ tab, own }: { tab: Tab; own?: OwnCard | null }) {
  const fields = own ? [own.card.legalName, own.card.city, own.card.industry, own.card.website, own.card.gstin || own.card.cin] : [];
  const done = fields.filter((f) => !!String(f ?? "").trim()).length;
  const missing = own ? [!own.card.city && "city", !own.card.industry && "industry", !own.card.website && "website", !(own.card.gstin || own.card.cin) && "GSTIN or CIN", !own.card.legalName && "legal name"].filter(Boolean) as string[] : [];
  const tips = tab === "people"
    ? [{ Icon: UserRound, title: "A name", text: "First name, last name or both" }, { Icon: AtSign, title: "An @handle", text: "Like @kedab.mifos" }]
    : [{ Icon: Building2, title: "A name", text: "Short or legal name. Hindi and Marathi work too" }, { Icon: AtSign, title: "An @handle", text: "Like @harbourbuilders" }, { Icon: BadgeCheck, title: "A GSTIN or CIN", text: "The exact company, every time" }];
  return <div className={css.start}>
    {own ? <section className={css.ownCard} aria-label="Your company on Vitals">
      <ProgressRing value={done / 5} size={76} stroke={8} label={`Public profile ${Math.round((done / 5) * 100)}% complete`}><b className={css.ownPct}>{Math.round((done / 5) * 100)}%</b></ProgressRing>
      <div className={css.ownText}>
        <h2>Your company on Vitals</h2>
        <p><b>{own.name}</b>{own.handle ? <span className={css.ownHandle}> @{own.handle}</span> : null} · {own.card.listed === false ? "hidden from search" : "people can find you"}</p>
        <p className={css.ownMissing}>{missing.length ? `Add your ${missing.slice(0, 3).join(", ")} so the right people find you.` : "Your profile is complete. Nice work!"}</p>
      </div>
      <Link href="/settings?tab=organisation" className={css.primaryLink}>{missing.length ? "Complete your profile" : "See your profile"}</Link>
    </section> : null}
    <section className={css.tips} aria-label="What you can search for">
      <h2>{tab === "people" ? "Find a person by" : "Find a company by"}</h2>
      <ul>{tips.map(({ Icon, title, text }) => <li key={title}><span className={css.tipIcon} aria-hidden="true"><Icon size={18} /></span><span><b>{title}</b><small>{text}</small></span></li>)}
        {tab === "companies" ? <li><span className={css.tipIcon} aria-hidden="true"><Languages size={18} /></span><span><b>Any spelling</b><small>Small typos still find it</small></span></li> : null}</ul>
    </section>
  </div>;
}

function Companies({ rows, q }: { rows: DirectoryCompany[]; q: string }) {
  // FIX-SHELL (Codex concept 3): no match is a designed state with its picture and one way on.
  if (!rows.length) return <EmptyState art="nothing" title={`No company called “${q}” on Vitals yet`} text="Check the spelling, or try its GSTIN or @handle." />;
  return <ul className={css.grid}>{rows.map((c) => <li key={c.id}>
    <Link href={`/directory/c/${encodeURIComponent(c.handle)}`} className={css.result}><CompanyLine company={c} />
      {matchWords(c.match) ? <span className={css.why}>{matchWords(c.match)}</span> : null}</Link>
  </li>)}</ul>;
}

function People({ rows, q }: { rows: DirectoryPerson[]; q: string }) {
  if (!rows.length) return <EmptyState art="nothing" title={`Nobody called “${q}” can be found`} text="They may not have chosen “Let people find me” yet." />;
  return <ul className={css.grid}>{rows.map((p) => <li key={p.handle}>
    <Link href={`/directory/p/${encodeURIComponent(p.handle)}`} className={css.result}>
      <span className={css.line}><PersonAvatar person={p} />
        <span className={css.lineText}><span className={css.lineName}>{p.name}</span>
          <span className={css.lineSub}>@{p.handle}{p.headline ? ` · ${p.headline}` : ""}{p.company ? ` · ${p.company.name}` : ""}</span></span></span>
      {matchWords(p.match) ? <span className={css.why}>{matchWords(p.match)}</span> : null}
    </Link>
  </li>)}</ul>;
}
