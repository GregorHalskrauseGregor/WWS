// Wählt den KI-Anbieter anhand von process.env.AI_PROVIDER aus.
// Jeder Provider bietet die gleiche Funktion: chat(systemPrompt, userMessage, options) -> Promise<{content, toolCalls}>
//   options.model      - Modellname überschreiben (sonst ENV-Default)
//   options.maxTokens  - Token-Limit für die Antwort
//   options.messages   - Multi-Message-Liste (für Tool-Loop)
//   options.tools      - Tool-Definitionen (für Tool-Use)
//
// Rollen: 'main' (Chat-Antworten) und 'light' (Themen-Klassifikation, Komprimierung).
// 'light' nutzt AI_PROVIDER_LIGHT + *_MODEL_LIGHT, fällt sonst auf 'main' zurück.

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
  return { ...provider, rolle, name };
}

module.exports = { getProvider };
