// OpenAI-Provider. Erwartet OPENAI_API_KEY und optional OPENAI_MODEL / OPENAI_MODEL_LIGHT.
// Unterstützt Text und Function-Calling (nativ in der OpenAI-API).
// Rückgabe: { content: string, toolCalls: [{id, name, args}] | null }
const { toolsFuerOpenAI } = require('../tools');

const DEFAULT_MODEL = 'gpt-4o-mini';
const LIGHT_MODEL = 'gpt-4o-mini';

async function chat(systemPrompt, userMessage, options = {}) {
  const istLight = options.rolle === 'light';
  const model = options.model
    || (istLight ? process.env.OPENAI_MODEL_LIGHT : process.env.OPENAI_MODEL)
    || (istLight ? LIGHT_MODEL : DEFAULT_MODEL);
  const maxTokens = options.maxTokens || (istLight ? 500 : 2000);

  const messages = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(options.messages) && options.messages.length > 0) {
    for (const m of options.messages) messages.push(m);
  } else {
    messages.push({ role: 'user', content: userMessage });
  }

  const body = { model, max_tokens: maxTokens, messages };
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = toolsFuerOpenAI(options.tools);
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('OpenAI-API-Fehler: ' + JSON.stringify(data).slice(0, 500));
  }

  const choice = data.choices?.[0];
  const message = choice?.message || {};
  const text = message.content || '';
  const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    ? message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: parseJsonArgs(tc.function.arguments)
      }))
    : null;
  return { content: text, toolCalls };
}

function parseJsonArgs(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = { chat, DEFAULT_MODEL, LIGHT_MODEL, supportsTools: true };
