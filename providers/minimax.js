// MiniMax-Provider. Erwartet MINIMAX_API_KEY und optional MINIMAX_MODEL bzw. MINIMAX_MODEL_LIGHT.
// Reine Text-API in dieser Version — Tools (web_search, web_fetch) sind hier deaktiviert.
// Für Web-Zugriff AI_PROVIDER auf anthropic oder openai stellen.
const DEFAULT_MODEL = 'MiniMax-M2';
const LIGHT_MODEL = 'MiniMax-M2-mini';

async function chat(systemPrompt, userMessage, options = {}) {
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    throw new Error(
      'MiniMax unterstützt in dieser Anbindung keine Tool-Aufrufe. ' +
      'Für Web-Zugriff AI_PROVIDER auf anthropic oder openai stellen.'
    );
  }

  const istLight = options.rolle === 'light';
  const model = options.model
    || (istLight ? process.env.MINIMAX_MODEL_LIGHT : process.env.MINIMAX_MODEL)
    || (istLight ? LIGHT_MODEL : DEFAULT_MODEL);
  const maxTokens = options.maxTokens || (istLight ? 500 : 2000);

  const messages = Array.isArray(options.messages) && options.messages.length > 0
    ? options.messages
    : [{ role: 'user', content: userMessage }];

  // MiniMax-API erwartet System-Prompt im messages-Array (nicht als eigenes Feld).
  const alle = [{ role: 'system', content: systemPrompt }, ...messages];

  const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: alle
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('MiniMax-API-Fehler: ' + JSON.stringify(data).slice(0, 500));
  }

  return { content: data.choices?.[0]?.message?.content || '', toolCalls: null };
}

module.exports = { chat, DEFAULT_MODEL, LIGHT_MODEL, supportsTools: false };
