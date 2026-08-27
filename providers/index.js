// Wählt den KI-Anbieter anhand von process.env.AI_PROVIDER aus.
// Jeder Provider bietet die gleiche Funktion: chat(systemPrompt, userMessage) -> Promise<string>
// Wechsel des Anbieters = nur AI_PROVIDER in der .env ändern, kein Code-Umbau.

const providers = {
  anthropic: require('./anthropic'),
  openai: require('./openai'),
  minimax: require('./minimax')
};

function getProvider() {
  const name = process.env.AI_PROVIDER || 'anthropic';
  const provider = providers[name];
  if (!provider) {
    throw new Error(
      `Unbekannter AI_PROVIDER "${name}". Erlaubt: ${Object.keys(providers).join(', ')}`
    );
  }
  return provider;
}

module.exports = { getProvider };
