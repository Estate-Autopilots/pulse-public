// SPEED-2 (15 Nov 2026): a policy draft's starting text and its shape, apart from the editor itself (policy-editor.tsx
// brings Pulse's doc editor, TipTap, 753 KB), so /hr and /me can list policies without loading it.

export type EditorDoc = { kind: string; kindLabel: string; title: string; body: string; version: number; revision: number; published: boolean; wordFile?: string | null };

/** A new policy starts from an outline HR fills in. */
export const template = (title: string) => `# ${title}\n\nVersion 1 (draft) · Applies to all employees\n\n## 1. Purpose\n\nWhat this policy is for.\n\n## 2. The rules\n\n- A rule\n- A rule that needs a decision **(confirm)**\n\n## 3. Questions\n\nAsk HR in Pulse → My desk → Requests.\n`;
