// OpenAI-Provider. Erwartet OPENAI_API_KEY und optional OPENAI_MODEL / OPENAI_MODEL_LIGHT.
// Reine Text-API in dieser Version (Bilder laufen vorher über Mistral OCR).
const DEFAULT_MODEL = 'gpt-4o-mini';
const LIGHT_MODEL = 'gpt-4o-mini';

async function chat(systemPrompt, userMessage, options = {}) {
  const istLight = options.rolle === 'light';
  const model = options.model
    || (istLight ? process.env.OPENAI_MODEL_LIGHT : process.env.OPENAI_MODEL)
    || (istLight ? LIGHT_MODEL : DEFAULT_MODEL);
  const maxTokens = options.maxTokens || (istLight ? 500 : 2000);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
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
    throw new Error('OpenAI-API-Fehler: ' + JSON.stringify(data));
  }

  return data.choices?.[0]?.message?.content || '';
}

module.exports = { chat, DEFAULT_MODEL, LIGHT_MODEL };
