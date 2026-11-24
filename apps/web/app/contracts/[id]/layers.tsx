"use client";
// POLISH-1115 (owner, 14 Nov 2026): "Who pays whom is not the only thing in a contract; there are a lot of layers."
// The agreement read as its layers, beside the document: who it is between, the money, what each side does, ownership
// and data, how long it lasts, limits and risk, law and disputes, general terms and the schedules. One row per layer
// (Codex concept 1, reports/polish-1115/concepts/contract-layers): its icon, its name, one line with its key facts, and
// its clause numbers; a tap scrolls the document to that clause's page. A structure, not a diagram.
import { useMemo } from "react";
import { CalendarClock, FileText, IndianRupee, Lightbulb, ListChecks, Paperclip, Scale, ShieldAlert, Users, type LucideIcon } from "lucide-react";
import { contractLayers, type ContractLayer } from "@pulse/invoice-doc/browser";
import { Fold } from "./fold";
import pro from "./pro.module.css";

const ICON: Record<string, LucideIcon> = { parties: Users, money: IndianRupee, duties: ListChecks, ip: Lightbulb, term: CalendarClock, risk: ShieldAlert, law: Scale, general: FileText, schedules: Paperclip };

/** The one line under a layer's name: its facts, else who it is between, the words it defines, or its clauses' titles. */
function summary(l: ContractLayer) {
  if (l.parties?.length) return l.parties.map((p) => p.defined ? `${p.name || "Not named yet"} (the ${p.defined})` : p.name).join(" · ");
  if (l.facts.length) return l.facts.map((f) => (l.key === "law" && f.label === "Courts of" ? `Courts of ${f.value}` : f.value)).join(" · ");
  if (l.terms?.length) return `Defines ${l.terms.slice(0, 5).join(", ")}${l.terms.length > 5 ? "…" : ""}`;
  return l.clauses.map((c) => c.title).filter(Boolean).join(", ");
}
/** Where a clause is in the document's bookmarks ("3. Fees and payment", "Schedule 1: …", "Parties"). */
const target = (c: { number: string; title: string }) => !c.number ? "Parties" : c.number.startsWith("Schedule") ? `${c.number}${c.title ? `: ${c.title}` : ""}` : `${c.number}. ${c.title}`;

/** The layers of the agreement in `body` (its source). `onJump` gets the bookmark's title of the part tapped. */
export function Layers({ body, onJump }: { body: string; onJump: (to: string) => void }) {
  const layers = useMemo(() => contractLayers(body), [body]);
  if (layers.length < 2) return null;
  return <Fold title="What it covers" label="What it covers" summary={`${layers.length} parts`}>
    <p className={pro.layerHint}>Tap a part to go to it in the agreement.</p>
    <ol className={pro.layers}>
      {layers.map((l) => {
        const Icon = ICON[l.key] ?? FileText;
        const nums = l.clauses.filter((c) => c.number);
        const first = l.key === "parties" ? "Parties" : nums[0] ? target(nums[0]) : null;
        const badge = nums.length ? nums.map((c) => c.number.replace("Schedule ", "Sch. ")).slice(0, 3).join(", ") + (nums.length > 3 ? "…" : "") : null;
        const line = summary(l);
        const inner = <>
          <span className={pro.layerIcon} aria-hidden="true"><Icon size={16} /></span>
          <span className={pro.layerBody}><strong>{l.label}</strong>{line ? <small>{line}</small> : null}</span>
          {badge ? <span className={pro.layerBadge} aria-label={nums.length === 1 ? `Clause ${badge}` : `Clauses ${badge}`}>{badge}</span> : null}
        </>;
        return <li key={l.key} data-layer={l.key}>
          {first ? <button type="button" onClick={() => onJump(first)} title={`Go to ${first}`}>{inner}</button> : <div>{inner}</div>}
        </li>;
      })}
    </ol>
  </Fold>;
}
