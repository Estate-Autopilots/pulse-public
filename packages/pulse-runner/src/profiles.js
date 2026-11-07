/** The runner owns what each profile means. Pulse sends only the name. */
export const PROFILES = Object.freeze({
  'read-only': { rank: 0, tools: ['Read', 'Glob', 'Grep'], codexSandbox: 'read-only', needsApproval: false },
  write: { rank: 1, tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit'], codexSandbox: 'workspace-write', needsApproval: true },
  shell: { rank: 2, tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash'], codexSandbox: 'workspace-write', needsApproval: true },
  // AI-EMPLOYEE-POWER: a root shell job (kind 'shell' only), outside the sandbox, through the root helper. It needs the
  // owner's grant in Pulse AND allowRoot in this server's local config; maxProfile does not cap it (allowRoot does).
  root: { rank: 3, tools: [], codexSandbox: 'danger-full-access', needsApproval: true },
});

/** AI-EMPLOYEE-POWER: the root helper (root-owned, run with sudo -n): reads the command line on stdin, runs it as root. */
export const ROOT_HELPER = '/usr/local/sbin/pulse-runner-root';
/** The longest command line a 'shell' job takes. */
export const SHELL_MAX_BYTES = 20000;

export const DEFAULT_PROFILE = 'read-only';
export const MCP_TOOL_RULE = 'mcp__pulse';

export function profileWithinCeiling(name, ceiling) {
  const profile = PROFILES[name];
  const max = PROFILES[ceiling] ?? PROFILES[DEFAULT_PROFILE];
  return Boolean(profile) && profile.rank <= max.rank;
}

/** Commands for `shell-safe` jobs. Each one neither runs other programs nor prints file contents. */
export const SHELL_SAFE_COMMANDS = Object.freeze(['echo', 'uname', 'uptime', 'df', 'free', 'nproc', 'sleep']);
export const SHELL_SAFE_DIRS = Object.freeze(['/usr/bin', '/bin']);
