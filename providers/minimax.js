// MiniMax-Provider. Erwartet MINIMAX_API_KEY und optional MINIMAX_MODEL.
// MiniMax-M2 kann (Stand jetzt) keine Bilder verarbeiten -> klare Fehlermeldung statt stillem Fehlschlag.
async function chat(systemPrompt, userMessage, bilder = []) {
  if (bilder.length > 0) {
    throw new Error(
      'MiniMax unterstützt in dieser Anbindung keine Bilderkennung. ' +
      'Für den Lieferschein-/Screenshot-Import AI_PROVIDER auf anthropic oder openai stellen.'
    );
  }

  const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MINIMAX_MODEL || 'MiniMax-M2',
      max_tokens: 1000,
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

module.exports = { chat };
