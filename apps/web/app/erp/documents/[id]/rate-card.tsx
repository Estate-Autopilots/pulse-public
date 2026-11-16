"use client";
// KAZUK-REST (6 Nov 2026; Kazuk's Quotation Builder v2, A8): build quotation lines from a service's rate card, inside the
// one Billing composer. Pick the card, the talent level, the period and X; tick the add-ons; the price shows as it is
// worked out (base × X × talent × period, plus add-ons) and "Add to the quotation" puts the lines on it. The database
// prices each saved line from its card, so a different price typed later is a request that is approved.
import { useState } from "react";
import { Calculator } from "lucide-react";
import { formatAmount } from "@pulse/invoice-doc/browser";
import { styles } from "../../../ui";
import { Drawer, DrawerFooter, DrawerSection } from "../../../kit/drawer";
import { Stepper } from "../../../kit/line-row";
import { cardLines, cardPrice, periodUnit, type CardLine, type RateCardPick } from "../../../lib/rate-card.mjs";
import css from "../documents.module.css";

const inr = (paise: number) => `₹${formatAmount(paise)}`;
const factor = (f: number) => (f === 1 ? "standard" : `× ${f}`);

export function RateCardDrawer({ cards, noun, onAdd, onClose }: { cards: RateCardPick[]; noun: string; onAdd: (lines: { main: CardLine; addOns: CardLine[] }) => void; onClose: () => void }) {
  const [cardId, setCardId] = useState(cards[0]?.id ?? "");
  const card = cards.find((c) => c.id === cardId) ?? cards[0];
  const [talent, setTalent] = useState(card?.talents[0]?.key ?? ""), [period, setPeriod] = useState(card?.periods[0]?.key ?? "");
  const [x, setX] = useState(card?.xMin ?? 1), [addOns, setAddOns] = useState<string[]>([]);
  if (!card) return null;
  const pick = (id: string) => {
    const c = cards.find((k) => k.id === id);
    if (!c) return;
    setCardId(id); setTalent(c.talents[0]?.key ?? ""); setPeriod(c.periods[0]?.key ?? ""); setX(c.xMin); setAddOns([]);
  };
  const sel = { x, talent, period, addOns };
  const lines = cardLines(card, sel);
  const total = lines ? lines.main.rate + lines.addOns.reduce((n, a) => n + a.rate, 0) : null;
  const p = card.periods.find((v) => v.key === period), t = card.talents.find((v) => v.key === talent);
  const step = card.xMax - card.xMin >= 2 || Number.isInteger(card.xMin) ? 1 : 0.5;
  return <Drawer title="Rate card" context={`Lines for this ${noun}, priced from the card`} onClose={onClose} size="md" snap="full" noAutofocus
    footer={<DrawerFooter tone="info" status={total !== null ? <>Before GST <b>{inr(total)}</b>{p ? ` per ${periodUnit(p.months)}` : ""}</> : "Choose from the card"}
      primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!lines} onClick={() => lines && onAdd(lines)}>Add to the {noun}</button>} />}>
    {cards.length > 1 ? <DrawerSection title="Service">
      <div className={css.radios} role="radiogroup" aria-label="Rate card">
        {cards.map((c) => <label key={c.id} className={css.radio}><input type="radio" name="rc-card" checked={c.id === card.id} onChange={() => pick(c.id)} />{c.name}
          <small>{c.serviceName && c.serviceName !== c.name ? ` · ${c.serviceName}` : ""} · {inr(c.base)} a month</small></label>)}
      </div>
    </DrawerSection> : <p className={css.note}><Calculator size={13} aria-hidden="true" /> <b>{card.name}</b> · base {inr(card.base)} a month</p>}
    <DrawerSection title="Talent level">
      <div className={css.radios} role="radiogroup" aria-label="Talent level">
        {card.talents.map((v) => <label key={v.key} className={css.radio}><input type="radio" name="rc-talent" checked={v.key === talent} onChange={() => setTalent(v.key)} />{v.label}<small> · {factor(v.factor)}</small></label>)}
      </div>
    </DrawerSection>
    <DrawerSection title="Period">
      <div className={css.radios} role="radiogroup" aria-label="Period">
        {card.periods.map((v) => <label key={v.key} className={css.radio}><input type="radio" name="rc-period" checked={v.key === period} onChange={() => setPeriod(v.key)} />{v.label}
          <small> · {v.months === 1 ? "1 month" : `${v.months} months`}{v.factor !== 1 ? ` · × ${v.factor}` : ""}</small></label>)}
      </div>
    </DrawerSection>
    <DrawerSection title={card.xLabel} aside={`${card.xMin} to ${card.xMax}`}>
      <Stepper label={card.xLabel} value={x} min={card.xMin} max={card.xMax} step={step} onChange={(n) => setX(n)} />
    </DrawerSection>
    {card.addOns.length ? <DrawerSection title="Add-ons">
      {card.addOns.map((a) => { const price = cardPrice(card, { ...sel, part: `addon:${a.key}` });
        return <label key={a.key} className={css.check}><input type="checkbox" checked={addOns.includes(a.key)} onChange={(e) => setAddOns(e.target.checked ? [...addOns, a.key] : addOns.filter((k) => k !== a.key))} />
          {a.label} · {price !== null ? inr(price) : "–"}{a.per === "month" ? p ? ` for ${p.months === 1 ? "the month" : `${p.months} months`}` : "" : " once"}</label>; })}
    </DrawerSection> : null}
    <DrawerSection title="Price">
      {lines && t && p ? <>
        <p className={css.price}><b>{inr(lines.main.rate)}</b><span className={css.hint}>{inr(card.base)} × {x} × {t.factor} × {p.months}{p.factor !== 1 ? ` × ${p.factor}` : ""}</span></p>
        <ul className={css.note} aria-label="Lines it adds">
          <li>{lines.main.description} · {inr(lines.main.rate)}</li>
          {lines.addOns.map((a) => <li key={a.rateCard.part}>{a.description} · {inr(a.rate)}</li>)}
        </ul>
        <p className={css.note}>GST is added on the {noun} as for the service. A different price typed later is a request: a manager or the owner approves it.</p>
      </> : <p className={css.note} role="alert">Choose a talent level, a period and {card.xLabel.toLowerCase()} from {card.xMin} to {card.xMax}.</p>}
    </DrawerSection>
  </Drawer>;
}
