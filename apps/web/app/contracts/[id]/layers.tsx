"use client";
// POLISH-1115 (owner, 14 Nov 2026): "Who pays whom is not the only thing in a contract; there are a lot of layers."
// The agreement read as its layers, beside the document: who it is between, the money, what each side does, ideas and
// data, how long it lasts, limits and risk, law and disputes, general terms and the schedules. Each layer names its
// clauses (a tap scrolls the document to that clause's page) and the deal's facts that belong to it. A structure, not
// a diagram: one row per layer, in the order a reader asks about them.
import { useMemo } from "react";
import { CalendarClock, FileText, IndianRupee, Lightbulb, ListChecks, Paperclip, Scale, ShieldAlert, Users, type LucideIcon } from "lucide-react";
import { contractLayers } from "@pulse/invoice-doc/browser";
import { Fold } from "./fold";
import pro from "./pro.module.css";

const ICON: Record<string, LucideIcon> = { parties: Users, money: IndianRupee, duties: ListChecks, ip: Lightbulb, term: CalendarClock, risk: ShieldAlert, law: Scale, general: FileText, schedules: Paperclip };

/** The layers of the agreement in `body` (its source). `onJump` gets the bookmark's title of the part tapped. */
export function Layers({ body, onJump }: { body: string; onJump: (to: string) => void }) {
  const layers = useMemo(() => contractLayers(body), [body]);
  if (layers.length < 2) return null;
  const clauses = layers.reduce((n, l) => n + l.clauses.filter((c) => c.number && !c.number.startsWith("Schedule")).length, 0);
  return <Fold title="What it covers" label="What it covers" summary={`${layers.length} parts · ${clauses} ${clauses === 1 ? "clause" : "clauses"}`}>
    <ol className={pro.layers}>
      {layers.map((l) => {
        const Icon = ICON[l.key] ?? FileText;
        return <li key={l.key} data-layer={l.key}>
          <span className={pro.layerIcon} aria-hidden="true"><Icon size={16} /></span>
          <div className={pro.layerBody}>
            <strong>{l.label}</strong>
            {l.parties?.length ? <ul className={pro.layerParties}>{l.parties.map((p, i) => <li key={`${p.name}-${i}`}>
              <button type="button" onClick={() => onJump("Parties")}>{p.name || `${p.defined || "A party"}: name not filled`}</button>
              <span>{[p.defined ? `the ${p.defined}` : "", p.type].filter(Boolean).join(" · ")}</span>
            </li>)}</ul> : null}
            {l.facts.length ? <dl className={pro.layerFacts}>{l.facts.slice(0, 4).map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl> : null}
            {l.terms?.length ? <p className={pro.layerTerms}>{`Words it defines: ${l.terms.slice(0, 8).join(", ")}`}</p> : null}
            {l.clauses.filter((c) => c.number).length ? <div className={pro.layerClauses}>
              {l.clauses.filter((c) => c.number).map((c) => {
                const to = c.number.startsWith("Schedule") ? `${c.number}${c.title ? `: ${c.title}` : ""}` : `${c.number}. ${c.title}`;
                return <button key={to} type="button" onClick={() => onJump(to)} title={`Go to ${to}`}>
                  <b>{c.number.startsWith("Schedule") ? c.number.replace("Schedule", "Sch.") : c.number}</b>{c.title}
                </button>;
              })}
            </div> : null}
          </div>
        </li>;
      })}
    </ol>
  </Fold>;
}
