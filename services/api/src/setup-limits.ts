// ONBOARD-CONFIG: how much one company setup proposes (setup-config.ts and the v1 schema in v1-setup.ts), kept apart so
// the v1 schema reads it while routes.ts loads (setup-config.ts imports routes.ts back).
export const LIMITS = { teams: 20, roles: 20, workflows: 12, steps: 15, goals: 8, projects: 20, docs: 10 } as const;
