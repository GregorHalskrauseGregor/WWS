// OpenAI-Provider. Erwartet OPENAI_API_KEY und optional OPENAI_MODEL.
// Unterstützt Text UND Bilder (für Lieferschein-/Screenshot-Import), sofern das gewählte
// Modell Vision unterstützt (z. B. gpt-4o, gpt-4o-mini).
async function chat(systemPrompt, userMessage, bilder = []) {
  let content = userMessage;
  if (bilder.length > 0) {
    content = [
      { type: 'text', text: userMessage },
      ...bilder.map((b) => ({
        type: 'image_url',
        image_url: { url: `data:${b.mimeType};base64,${b.base64}` }
      }))
    ];
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content }
      ]
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('OpenAI-API-Fehler: ' + JSON.stringify(data));
  }

  return data.choices?.[0]?.message?.content || '';
}

module.exports = { chat };
