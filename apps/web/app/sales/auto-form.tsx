"use client";

// KAZUK-V2: a GET form that applies itself when a choice changes (the salesperson picker on My sales and Deals), so
// there is no separate "Show" button. The kit's SelectField fires a real change event, which bubbles here.
import type { ReactNode } from "react";

export function AutoForm({ action, className, label, children }: { action: string; className?: string; label: string; children: ReactNode }) {
  return <form action={action} className={className} aria-label={label} onChange={(e) => e.currentTarget.requestSubmit()}>{children}</form>;
}
