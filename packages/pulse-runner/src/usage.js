const num = (value) => (Number.isFinite(value) ? value : null);

export function emptyUsage(source) {
  return { costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, numTurns: null, source };
}

const add = (a, b) => (b === null ? a : (a ?? 0) + b);

/**
 * Reads usage out of one line of CLI JSON, where the CLI reports it.
 * Returns { usage?, limits?, isError?, budgetExceeded? }.
 */
export function parseAgentLine(kind, event, current) {
  if (!event || typeof event !== 'object') return {};
  if (kind === 'claude') {
    if (event.type === 'rate_limit_event') return { limits: event.rate_limit_info ?? event };
    if (event.type !== 'result') return {};
    const u = event.usage ?? {};
    return {
      usage: {
        costUsd: num(event.total_cost_usd),
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
        numTurns: num(event.num_turns),
        source: 'claude',
      },
      isError: event.is_error === true,
      budgetExceeded: event.subtype === 'error_max_budget_usd',
    };
  }
  if (kind === 'codex') {
    const limits = event.rate_limits ?? event.msg?.rate_limits;
    if (limits) return { limits };
    if (event.type === 'turn.failed' || event.type === 'error') return { isError: true };
    if (event.type !== 'turn.completed') return {};
    const u = event.usage ?? {};
    const base = current ?? emptyUsage('codex');
    return {
      usage: {
        ...base,
        inputTokens: add(base.inputTokens, num(u.input_tokens)),
        outputTokens: add(base.outputTokens, num(u.output_tokens)),
        cacheReadTokens: add(base.cacheReadTokens, num(u.cached_input_tokens)),
        numTurns: (base.numTurns ?? 0) + 1,
      },
    };
  }
  return {};
}
