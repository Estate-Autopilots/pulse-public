export type ItemFields = { ownerPersonId: string | null; doneOn: string | null; note: string | null };
export type SaveState = { saving: boolean; failed: number; drafts: Record<string, ItemFields>; intake: Record<string, string> };
export function sprintSaves<V>(io: {
  base: string;
  post: (path: string, body: Record<string, unknown>) => Promise<V>;
  show: (view: V) => void;
  change: (state: SaveState) => void;
  saved: (title: string) => void;
  failed: (message: string) => void;
  now?: () => string;
}): {
  item(kind: "input" | "milestone", key: string, current: ItemFields, edit: Partial<ItemFields>, done?: string): Promise<void>;
  sprint(field: string, value: string, done?: string): Promise<void>;
  retry(): Promise<void>;
};
