// FLOW-D: the modules by key, and the primitives under "block:<key>" (flow-canvas.mjs reads a block step through them).
// Shared by the builder (client) and the phone list (server).
import type { ModuleManifest, Primitive } from "../flow-types";

export function known(modules: ModuleManifest[], primitives: Primitive[]): Record<string, ModuleManifest> {
  return Object.fromEntries([...modules.map((m) => [m.key, m]), ...primitives.map((p) => [`block:${p.key}`, { ...p, key: `block:${p.key}`, category: "Flow", needs: [], makes: [], engine: "live", settings: [],
    defaults: {}, pip: [], surface: "none", finish: "person", version: 1, status: "" } as unknown as ModuleManifest])]) as Record<string, ModuleManifest>;
}
