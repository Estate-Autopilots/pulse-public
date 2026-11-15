"use client";
import { Printer } from "lucide-react";
import css from "../../../hq.module.css";

/** Prints the offer sheet (or saves it as a PDF from the print dialog). */
export function PrintButton() {
  return <button type="button" className={css.primary} onClick={() => window.print()}><Printer size={15} aria-hidden="true" />Print or save PDF</button>;
}
