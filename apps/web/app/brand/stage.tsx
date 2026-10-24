"use client";
// Pip's gallery controls: replay the one-shot moves (perk, hop, wave) and freeze every pose to compare them.
import { useState, type ReactNode } from "react";
import css from "./brand.module.css";

export function PipStage({ children }: { children: ReactNode }) {
  const [still, setStill] = useState(false);
  const [round, setRound] = useState(0);
  return (
    <div className={css.stage} data-still={still ? "" : undefined}>
      <div className={css.stageTools}>
        <button type="button" className={css.tool} onClick={() => setRound((r) => r + 1)}>Replay</button>
        <button type="button" className={css.tool} aria-pressed={still} onClick={() => setStill((s) => !s)}>{still ? "Moving" : "Still"}</button>
      </div>
      <div key={round}>{children}</div>
    </div>
  );
}
