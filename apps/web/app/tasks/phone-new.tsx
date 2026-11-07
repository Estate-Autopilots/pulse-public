"use client";
// PROJECTS-CREATE (4 Nov 2026): on a phone, Work (My work, Projects) and My day show a visible "+ New" that opens the Create
// dialog (a task, or a project for those who may start one). The C and N keys are desktop only, and a company owner on a
// phone found no way to create anything. Wider screens keep their header buttons and keys; this button only shows on phones.
import { Plus } from "lucide-react";
import { openCreate } from "../create";
import css from "./phone-new.module.css";

export function PhoneNewButton({ kind }: { kind?: "task" | "project" }) {
  return <button type="button" className={css.fab} onClick={() => openCreate(kind ? { kind } : undefined)} aria-label="New task or project" data-phone-new="">
    <Plus size={20} aria-hidden="true" /><span>New</span></button>;
}
