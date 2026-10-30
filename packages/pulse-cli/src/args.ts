// A small, strict argument parser: options are declared per command, so a typo is an error that lists what exists.
import { usage } from './errors.js';

export type Spec = { values: Set<string>; booleans: Set<string>; negatable?: Set<string> };
export type Parsed = { positionals: string[]; values: Map<string, string[]>; booleans: Map<string, boolean> };

export const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

export function parse(tokens: string[], spec: Spec, command = 'pulse'): Parsed {
  const out: Parsed = { positionals: [], values: new Map(), booleans: new Map() };
  const known = () => [...spec.values].map(v => `--${v} <value>`).concat([...spec.booleans].map(b => `--${b}`)).sort().join(', ');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') { out.positionals.push(...tokens.slice(i + 1)); break; }
    if (token === '-h') { out.booleans.set('help', true); continue; }
    if (!token.startsWith('--') || token === '-') {
      if (token.startsWith('-') && token !== '-' && !/^-\d/.test(token)) usage(`Unknown option ${token} for \`${command}\``, `Options: ${known()}`);
      out.positionals.push(token); continue;
    }
    const eq = token.indexOf('=');
    const name = token.slice(2, eq < 0 ? undefined : eq), inline = eq < 0 ? undefined : token.slice(eq + 1);
    if (spec.booleans.has(name)) {
      if (inline !== undefined && !['true', 'false'].includes(inline)) usage(`--${name} takes no value (or =true / =false)`);
      out.booleans.set(name, inline !== 'false'); continue;
    }
    if (name.startsWith('no-') && (spec.booleans.has(name.slice(3)) || spec.negatable?.has(name.slice(3)))) {
      if (inline !== undefined) usage(`--${name} takes no value`);
      out.booleans.set(name.slice(3), false); continue;
    }
    if (spec.values.has(name)) {
      const value = inline ?? tokens[++i];
      if (value === undefined) usage(`--${name} needs a value`);
      out.values.set(name, [...(out.values.get(name) ?? []), value]); continue;
    }
    usage(`Unknown option --${name} for \`${command}\``, `Options: ${known()}`);
  }
  return out;
}

/** The single value of an option given once (an error when given twice). */
export function one(parsed: Parsed, name: string): string | undefined {
  const v = parsed.values.get(name);
  if (v && v.length > 1) usage(`--${name} was given more than once`);
  return v?.[0];
}
