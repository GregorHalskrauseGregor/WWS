// Anthropic-Provider. Erwartet ANTHROPIC_API_KEY und optional ANTHROPIC_MODEL / ANTHROPIC_MODEL_LIGHT.
// Unterstützt Text und Tool-Use (nativ in der Anthropic-API).
// Rückgabe: { content: string, toolCalls: [{id, name, args}] | null }
const { toolsFuerAnthropic } = require('../tools');

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const LIGHT_MODEL = 'claude-haiku-4-5';

async function chat(systemPrompt, userMessage, options = {}) {
  const istLight = options.rolle === 'light';
  const model = options.model
    || (istLight ? process.env.ANTHROPIC_MODEL_LIGHT : process.env.ANTHROPIC_MODEL)
    || (istLight ? LIGHT_MODEL : DEFAULT_MODEL);
  const maxTokens = options.maxTokens || (istLight ? 500 : 2000);

  // Messages-Liste wird vom Bot-Loop aufgebaut, wenn Tools im Spiel sind.
  // Im einfachen Fall (kein Tool-Loop) reicht eine User-Message.
  const messages = Array.isArray(options.messages) && options.messages.length > 0
    ? options.messages
    : [{ role: 'user', content: userMessage }];

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages
  };
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = toolsFuerAnthropic(options.tools);
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Anthropic-API-Fehler: ' + JSON.stringify(data).slice(0, 500));
  }

  // Anthropic gibt ein Array von Blöcken zurück. Wir trennen Text von tool_use.
  let text = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += (text ? '\n' : '') + block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
    }
  }
  return { content: text, toolCalls: toolCalls.length ? toolCalls : null };
}

module.exports = { chat, DEFAULT_MODEL, LIGHT_MODEL, supportsTools: true };
