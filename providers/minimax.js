// MiniMax-Provider. Erwartet MINIMAX_API_KEY und optional MINIMAX_MODEL bzw. MINIMAX_MODEL_LIGHT.
// Reine Text-API. Bilder werden derzeit nicht unterstützt (OCR-Pfad läuft vorher über Mistral).
const DEFAULT_MODEL = 'MiniMax-M2';
const LIGHT_MODEL = 'MiniMax-M2-mini';

async function chat(systemPrompt, userMessage, options = {}) {
  const istLight = options.rolle === 'light';
  const model = options.model
    || (istLight ? process.env.MINIMAX_MODEL_LIGHT : process.env.MINIMAX_MODEL)
    || (istLight ? LIGHT_MODEL : DEFAULT_MODEL);
  const maxTokens = options.maxTokens || (istLight ? 500 : 2000);

  const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('MiniMax-API-Fehler: ' + JSON.stringify(data));
  }

  return data.choices?.[0]?.message?.content || '';
}

module.exports = { chat, DEFAULT_MODEL, LIGHT_MODEL };
