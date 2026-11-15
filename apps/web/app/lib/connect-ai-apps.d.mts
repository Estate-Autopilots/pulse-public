export type AiShot = { kind: "menu"; path: string[]; button: string } | { kind: "fields"; rows: [string, string][] } | { kind: "terminal"; line: string } | { kind: "allow" };
export type AiWay = { key: string; label: string; copy: { label: string; text: string }; steps: string[]; shots: AiShot[]; note?: string; link?: { href: string; label: string } };
export type AiApp = { key: string; name: string; sub: string; signIn: boolean; ways: AiWay[] };
export function installLinks(url: string, slug: string): { cursor: string; vscode: string };
export function aiApps(o: { url: string; brand: string; key?: string | null }): AiApp[];
