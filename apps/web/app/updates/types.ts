export type UpdateCounts = { live: number; readyToTry: number; requests: number; ideas: number; needsYou: number };
export type UpdateSummary = {
  id: string; slot: string; period: "morning" | "night"; headline: string; createdAt: string;
  poster: string; onBehalf: { id: string; name: string }; openedAt: string | null; isSender: boolean; counts: UpdateCounts;
};
export type UpdateItem = { title: string; note?: string; tag?: string };
export type UpdateDetail = UpdateSummary & {
  sections: {
    live?: UpdateItem[]; readyToTry?: UpdateItem[]; ideas?: UpdateItem[];
    requests?: { title: string; note?: string; status: string; progress: number }[];
    needsYou?: { text: string }[]; plan?: { label: "Today" | "Tomorrow"; items: UpdateItem[] };
  };
  openedBy?: { personId: string; name: string; openedAt: string | null }[];
};
export type UpdateList = { items: UpdateSummary[]; nextCursor: string | null };
