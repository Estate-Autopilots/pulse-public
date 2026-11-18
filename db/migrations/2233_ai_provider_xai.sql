-- migrate:up
-- AI-AGENTS-2 (owner, 17 Nov 2026: model choices across "Claude, OpenAI, Google Gemini, Grok, Mistral, DeepSeek"): Pulse
-- already took API keys from Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek and any
-- OpenAI-compatible server (0958); xAI's Grok is added, an OpenAI-style API at api.x.ai (services/api/src/ai-providers.ts).
alter table pulse.ai_connection drop constraint ai_connection_provider_check;
alter table pulse.ai_connection add constraint ai_connection_provider_check
  check (provider in ('claude','codex','anthropic','openai','gemini','openrouter','groq','mistral','deepseek','xai','custom'));

-- migrate:down
-- A kept xAI connection makes this step fail on purpose (nothing is deleted).
alter table pulse.ai_connection drop constraint ai_connection_provider_check;
alter table pulse.ai_connection add constraint ai_connection_provider_check
  check (provider in ('claude','codex','anthropic','openai','gemini','openrouter','groq','mistral','deepseek','custom'));
