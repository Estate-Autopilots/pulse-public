// R55 part 4: Review data ranked by what needs attention. Every pending suggestion, whatever its kind, gets an impact
// (what is wrong or blocked until someone decides), a one-sentence explanation and the one action that resolves it.
// Score = impact × (0.55 + 0.45 × confidence): a strong, likely suggestion first; a weak guess about a small thing last.

export type AttentionInput = { id: string; kind: string; title: string; proposed: Record<string, unknown>; confidence: number | null; evidence: unknown;
  entityType: string | null; entityId: string | null; projectName?: string | null; personName?: string | null; managerName?: string | null };
export type AttentionAction = { label: string; needs?: "pod" | "option" | "point" | null };
export type Attention = { id: string; kind: string; title: string; why: string; impact: number; impactNote: string; score: number; confidence: number | null;
  action: AttentionAction | null; dismiss: string; options?: { id: string; label: string; note?: string }[]; href?: string; search?: string; group: string };

const str = (x: unknown) => typeof x === "string" ? x : x === null || x === undefined ? "" : String(x);
const num = (x: unknown) => typeof x === "number" ? x : Number(x ?? 0) || 0;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);
const evidenceWhy = (e: unknown) => e && typeof e === "object" && !Array.isArray(e) ? str((e as Record<string, unknown>).why || (e as Record<string, unknown>).note) : "";
export const KIND_GROUP: Record<string, string> = { geocode: "Map", talent: "Models", correction: "Corrections", identity: "People", manager: "People", opening_balance: "People",
  holiday: "Calendar", duplicate: "Records", project_pod: "Projects", onboard_project_new: "Projects", contact_type: "Contacts", data_gap: "Records", wa_contact: "Contacts" };

export function attention(r: AttentionInput, today: string): Attention {
  const p = r.proposed ?? {};
  const base = { id: r.id, kind: r.kind, title: r.title, confidence: r.confidence, group: KIND_GROUP[r.kind] ?? "Other", dismiss: "Dismiss" };
  let impact = 10, impactNote = "", why = evidenceWhy(r.evidence), action: AttentionAction | null = { label: "Accept" }, extra: Partial<Attention> = {};
  switch (r.kind) {
    case "geocode": {
      const projects = num(p.projects) || 1, rule = str(p.rule);
      impact = rule === "locality_centre" ? Math.min(90, 20 + projects * 7) : rule === "folder_place" ? 30 : 15;
      impactNote = rule === "locality_centre" ? `${projects} ${projects === 1 ? "project sits" : "projects sit"} at this centre` : "One project's pin";
      action = p.lat !== null && p.lat !== undefined ? { label: `Move to ${str(p.place)}` } : { label: "Save point", needs: "point" };
      extra = { dismiss: "Keep", search: str(p.search), href: "/map" };
      break;
    }
    case "talent": {
      const options = Array.isArray(p.options) ? (p.options as Record<string, unknown>[]).map((o) => ({ id: str(o.id), label: str(o.label), note: str(o.note) || undefined })) : [];
      if (p.what === "alias") {
        const seen = num((r.title.match(/\((\d+) shoot/) ?? [])[1]);
        impact = Math.min(80, 12 + seen * 2); impactNote = `${seen || "Some"} shoot ${seen === 1 ? "line" : "lines"} wait for a model`;
        const guess = options.find((o) => o.id === str(p.personId));
        action = guess ? { label: `It's ${guess.label}` } : { label: "Choose the model", needs: "option" };
        why ||= guess ? `Written without a surname; ${guess.label} has ${guess.note === "portfolio folder" ? "a portfolio folder" : "the full name in the sheets"}. Until someone confirms, the shoots count for ${guess.label} only provisionally.` : "Pulse could not tell which model this is; the shoots are not counted for anyone yet.";
      } else {
        impact = 18; impactNote = "A shoot's project decides the model's clients and videos";
        const guess = options.find((o) => o.id === str(p.projectId));
        action = guess ? { label: `Link to ${guess.label}` } : { label: "Choose the project", needs: "option" };
      }
      extra = { options };
      break;
    }
    case "correction": impact = 70; impactNote = "Someone says a record is wrong"; why ||= str(p.instruction) || "A person or a source check says this record is wrong. Fix the record, then mark it done."; action = { label: "Mark fixed" }; extra = { dismiss: "Not wrong" }; break;
    case "identity": impact = 55; impactNote = "Credit and HR records may go to the wrong person"; why ||= `${str(p.name) || "This name"} in an HR sheet matches no one, or more than one person.`; action = null; extra = { href: "/review-data?kind=identity&view=items" }; break;
    case "manager": impact = 60; impactNote = "Decides who approves leave and corrections"; why ||= `${r.personName ?? "This person"} has no confirmed manager; ${r.managerName ?? "the suggested lead"} is proposed. ${str(p.basis)}`.trim(); action = { label: r.managerName ? `Report to ${r.managerName}` : "Accept" }; break;
    case "holiday": {
      const day = str(p.day), until = day ? daysBetween(day, today) : 999;
      impact = until < 0 ? 8 : until <= 45 ? 65 : 25; impactNote = until < 0 ? "Already passed" : until <= 45 ? `In ${until} ${until === 1 ? "day" : "days"}` : "Later this year";
      why ||= `${str(p.name)} on ${day}: attendance and leave count it as a holiday only once it is on the calendar.`; action = { label: "Add to the calendar" }; break;
    }
    case "opening_balance": impact = 45; impactNote = "Someone's leave balance is waiting"; why ||= `${str(p.personLabel) || "A person"}'s carried-forward ${num(p.days)} days of leave wait for HR to confirm who it is.`; action = null; extra = { href: "/review-data?kind=opening_balance&view=items" }; break;
    case "duplicate": impact = 30; impactNote = "History split across two records"; why ||= "Two records look like the same one; until they are merged, deliveries and money are counted twice or split.";
      action = p.entity === "project" ? { label: "Merge" } : null; extra = p.entity === "project" ? {} : { href: "/contacts/identity" }; break;
    case "project_pod": impact = 12; impactNote = "Workload and ownership count for no pod"; why ||= `${r.projectName ?? "This project"} has no pod${str(p.pod) ? `; the sources say ${str(p.pod)}` : ""}.`;
      action = str(p.pod) ? { label: `Assign ${str(p.pod)}` } : { label: "Choose a pod", needs: "pod" }; break;
    case "onboard_project_new": impact = 35; impactNote = "A Drive folder is not a Pulse project yet"; why ||= "A new client folder appeared in Drive; creating the project links its files, deliveries and tasks."; action = { label: "Create the project" }; break;
    case "contact_type": impact = 4; impactNote = "A tidier contact list"; why ||= `Sources name this contact as ${str(p.contactType).replaceAll("_", " ") || "unknown"}.`; action = { label: `Mark as ${str(p.contactType).replaceAll("_", " ") || "other"}` }; break;
    case "wa_contact":
      if (p.newContact) { impact = 8; impactNote = "Someone the chats name who is not in Pulse"; why ||= "The client's WhatsApp groups name this person; accepting adds them as the client's point of contact (no invitation)."; action = { label: "Add the contact" }; break; }
      impact = 6; impactNote = "A contact detail the chats show and Pulse lacks"; why ||= "The client's WhatsApp groups show this; accepting fills only what is still empty."; action = { label: "Fill it in" }; break;
    case "data_gap": {
      const missing = Array.isArray(p.missing) ? (p.missing as unknown[]).map(str) : [];
      impact = r.entityType === "person" ? 20 : 8; impactNote = `Missing ${missing.join(", ")}`; why ||= `${r.personName ?? r.projectName ?? r.title} has no ${missing.join(" or ")} yet. Fill it on the record; the item closes itself on the next check.`;
      action = null; extra = { href: r.entityType === "person" ? `/people/${r.entityId}` : `/projects/${r.entityId}`, dismiss: "Not needed" }; break;
    }
  }
  const score = Math.round(impact * (0.55 + 0.45 * (r.confidence ?? 0.6)) * 10) / 10;
  return { ...base, why: why || r.title, impact, impactNote, score, action, ...extra };
}

export function rankAttention(rows: AttentionInput[], today: string): Attention[] {
  return rows.map((r) => attention(r, today)).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}
