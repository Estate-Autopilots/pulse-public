// CONNECT-AI: an AI employee's call to an API provider with its organisation's key (Settings → AI), from this server:
// any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Mistral, DeepSeek, or a custom address), Anthropic's Messages
// API, or Google's Gemini API. The key is in memory for this call only; errors never carry it (scrub).
export class AuthError extends Error {}
const scrub = (s) => String(s).replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{8,}|Bearer\s+\S+|[A-Za-z0-9_-]{32,})/g, "••••").replace(/\s+/g, " ").trim().slice(0, 200);
const QUOTA = /quota|rate.?limit|insufficient.?(?:balance|credit|quota)|usage limit|limit reached/i;

async function post(url, headers, body, timeoutMs) {
  let r;
  try { r = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(`could not reach ${new URL(url).host}: ${scrub(e.message)}`); }
  const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) {
    const said = scrub(typeof d?.error === "object" ? d.error.message ?? "" : d?.error ?? d?.message ?? text.slice(0, 200));
    if (r.status === 401 || r.status === 403) throw new AuthError(`the provider refused the key (${r.status}): ${said}`);
    if (r.status === 429 || r.status === 402 || QUOTA.test(said)) { const e = new Error(`out of quota or rate-limited (${r.status}): ${said}`); e.quota = true; throw e; }
    const e = new Error(`the provider answered ${r.status}: ${said}`); e.status = r.status; throw e;
  }
  return d ?? {};
}

/** {text, tokens}: one prompt to the model. Thinking ("effort") is passed where the provider takes it. */
export async function callApi({ style, baseUrl, secret, provider }, model, prompt, effort, timeoutMs = 300000, maxOut = 4000) {
  if (!model) throw new Error("no model chosen for its AI connection");
  // FEATURES-1024: the run's output budget is the provider's max tokens.
  const base = String(baseUrl).replace(/\/+$/, ""), max = Math.max(256, Math.min(Number(maxOut) || 4000, 64000));
  if (style === "anthropic") {
    const h = { "x-api-key": secret, "anthropic-version": "2023-06-01" };
    const deep = effort === "high" || effort === "xhigh";
    const body = { model, max_tokens: deep ? max + (effort === "xhigh" ? 16000 : 8000) : max, messages: [{ role: "user", content: prompt }],
      ...(deep ? { thinking: { type: "enabled", budget_tokens: effort === "xhigh" ? 16000 : 8000 } } : {}) };
    // A model that does not think answers without it.
    const d = await post(`${base}/messages`, h, body, timeoutMs).catch((e) => { if (deep && e.status === 400) { const { thinking: _t, ...plain } = body; void _t; return post(`${base}/messages`, h, { ...plain, max_tokens: max }, timeoutMs); } throw e; });
    return { text: (d.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""), tokens: d.usage ? (d.usage.input_tokens ?? 0) + (d.usage.output_tokens ?? 0) : null,
      tokensIn: d.usage?.input_tokens ?? null, tokensOut: d.usage?.output_tokens ?? null };
  }
  if (style === "gemini") {
    const d = await post(`${base}/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": secret }, { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: max } }, timeoutMs);
    return { text: (d.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""), tokens: d.usageMetadata?.totalTokenCount ?? null,
      tokensIn: d.usageMetadata?.promptTokenCount ?? null, tokensOut: d.usageMetadata?.candidatesTokenCount ?? null };
  }
  // OpenAI-compatible. Reasoning effort only for OpenAI's own reasoning models (others may refuse the field).
  const reasoning = provider === "openai" && /^(o\d|gpt-5|gpt-6)/.test(model) && effort ? { reasoning_effort: effort === "xhigh" ? "high" : effort } : {};
  const d = await post(`${base}/chat/completions`, { authorization: `Bearer ${secret}` }, { model, max_tokens: max, messages: [{ role: "user", content: prompt }], ...reasoning }, timeoutMs);
  return { text: String(d.choices?.[0]?.message?.content ?? ""), tokens: d.usage?.total_tokens ?? null, tokensIn: d.usage?.prompt_tokens ?? null, tokensOut: d.usage?.completion_tokens ?? null };
}
