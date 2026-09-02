// Wählt den KI-Anbieter anhand von process.env.AI_PROVIDER aus.
// Jeder Provider bietet die gleiche Funktion: chat(systemPrompt, userMessage, options) -> Promise<string>
//   options.model    - Modellname überschreiben (sonst ENV-Default)
//   options.maxTokens - Token-Limit für die Antwort
//
// Rollen: 'main' (Chat-Antworten) und 'light' (Themen-Klassifikation, Komprimierung).
// 'light' nutzt AI_PROVIDER_LIGHT + *_MODEL_LIGHT, fällt sonst auf 'main' zurück.
// So kann später ein zweites kleines Modell rein, ohne dass Code angefasst werden muss.

const providers = {
  anthropic: require('./anthropic'),
  openai: require('./openai'),
  minimax: require('./minimax')
};

function liesProviderName(rolle) {
  if (rolle === 'light') {
    return process.env.AI_PROVIDER_LIGHT || process.env.AI_PROVIDER || 'anthropic';
  }
  return process.env.AI_PROVIDER || 'anthropic';
}

function getProvider(rolle = 'main') {
  const name = liesProviderName(rolle);
  const provider = providers[name];
  if (!provider) {
    throw new Error(
      `Unbekannter AI_PROVIDER "${name}" (Rolle: ${rolle}). ` +
      `Erlaubt: ${Object.keys(providers).join(', ')}`
    );
  }
  // Provider bekommen einen Marker, welche Rolle sie bedienen — manche Provider
  // (z.B. MiniMax später) können je Rolle andere Defaults mitbringen.
  // 'name' steht zusätzlich dabei, damit der Bot-Loop je nach Anbieter die
  // Tool-Use-Antworten ins richtige Format übersetzen kann (Anthropic vs. OpenAI
  // haben unterschiedliche Schemas für tool_result-Blöcke).
  return { ...provider, rolle, name };
}

module.exports = { getProvider };
