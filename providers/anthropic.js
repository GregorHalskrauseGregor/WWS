// Anthropic-Provider. Erwartet ANTHROPIC_API_KEY und optional ANTHROPIC_MODEL.
// Unterstützt Text UND Bilder (für Lieferschein-/Screenshot-Import).
async function chat(systemPrompt, userMessage, bilder = []) {
  let content = userMessage;
  if (bilder.length > 0) {
    content = [
      ...bilder.map((b) => ({
        type: 'image',
        source: { type: 'base64', media_type: b.mimeType, data: b.base64 }
      })),
      { type: 'text', text: userMessage }
    ];
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content }]
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Anthropic-API-Fehler: ' + JSON.stringify(data));
  }

  return data.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

module.exports = { chat };
