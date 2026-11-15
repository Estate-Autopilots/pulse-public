// DOCS-RICH: the part of Mermaid (MIT) the diagram block uses (diagram.tsx), declared here so a worktree whose
// node_modules were installed before Mermaid was added still typechecks. Mermaid's own types say the same of these calls.
declare module "mermaid" {
  type DocMermaidConfig = { startOnLoad?: boolean; securityLevel?: "strict" | "loose" | "antiscript" | "sandbox"; theme?: "default" | "neutral" | "dark" | "forest" | "base";
    fontFamily?: string; themeVariables?: Record<string, string> };
  const mermaid: { initialize(config: DocMermaidConfig): void; render(id: string, text: string): Promise<{ svg: string }> };
  export default mermaid;
}
