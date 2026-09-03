// Tool-Loop — die KI darf Werkzeuge aufrufen, der Code führt sie aus.
//
// Transport-neutral: WIE der Nutzer um Erlaubnis gefragt wird, entscheidet der
// Adapter (Telegram-Inline-Buttons, CLI-Prompt, Auto-Ja im Test). Vorher steckte
// die Telegram-Tastatur mitten in dieser Schleife.

const { SCHWELLEN } = require('../config');
const ratelimit = require('../ratelimit');

// Baut die Provider-spezifischen Nachrichten für Tool-Aufruf + Ergebnis.
function haengeToolRundeAn(messages, antwort, toolResults, providerName) {
  if (providerName === 'anthropic') {
    messages.push({
      role: 'assistant',
      content: antwort.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))
    });
    messages.push({
      role: 'user',
      content: toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.result }))
    });
    return;
  }
  // OpenAI-kompatibel; MiniMax nutzt dasselbe Schema. Ohne diesen Zweig hat
  // MiniMax die Tool-Ergebnisse nie gesehen und endlos denselben Call gemacht.
  messages.push({
    role: 'assistant',
    content: antwort.content || null,
    tool_calls: antwort.toolCalls.map((c) => ({
      id: c.id, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) }
    }))
  });
  for (const r of toolResults) {
    messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.result });
  }
}

// dienste = { frageBestaetigung(toolCalls) -> {erlaubt, grund}, protokoll(typ,text), melde(text) }
async function laufe({ chatId, systemPrompt, messages, werkzeuge, provider, dienste }) {
  let verlauf = [...messages];

  for (let runde = 0; runde < SCHWELLEN.MAX_TOOL_ITER; runde++) {
    const opts = { rolle: 'main', messages: verlauf, maxTokens: 2000 };
    if (werkzeuge.definitionen.length > 0) opts.tools = werkzeuge.definitionen;

    const antwort = await provider.chat(systemPrompt, '', opts);
    if (!antwort.toolCalls || antwort.toolCalls.length === 0) {
      return antwort.content || '';
    }

    // 1) Erlaubnis einholen (strikter Modus)
    const bestaetigung = await dienste.frageBestaetigung(antwort.toolCalls);
    if (!bestaetigung.erlaubt) {
      dienste.protokoll?.('Sicherheit', `Tool-Aufruf abgelehnt (${chatId}): ` +
        antwort.toolCalls.map((c) => c.name).join(', '));
      haengeToolRundeAn(verlauf, antwort, antwort.toolCalls.map((c) => ({
        id: c.id, name: c.name,
        result: `Tool-Aufruf wurde nicht ausgeführt: ${bestaetigung.grund}. ` +
          `Antworte ohne dieses Tool, aus deinem bisherigen Wissen.`
      })), provider.name);
      continue;
    }

    // 2) Limit prüfen
    const limit = ratelimit.pruefeToolCall(chatId);
    if (!limit.ok) {
      dienste.melde?.('⚠️ ' + limit.grund);
      dienste.protokoll?.('Sicherheit', `Tool-Limit erreicht (${chatId})`);
      haengeToolRundeAn(verlauf, antwort,
        antwort.toolCalls.map((c) => ({ id: c.id, name: c.name, result: limit.grund })),
        provider.name);
      continue;
    }
    ratelimit.zaehleToolCall(chatId, antwort.toolCalls.length);

    // 3) Ausführen — parallel, alle unabhängig voneinander
    const ergebnisse = await Promise.all(antwort.toolCalls.map(async (call) => {
      const result = await werkzeuge.ausfuehren(call.name, call.args);
      dienste.protokoll?.('Tool', `${call.name} (${chatId}): ${JSON.stringify(call.args).slice(0, 200)}`);
      return { id: call.id, name: call.name, result };
    }));

    haengeToolRundeAn(verlauf, antwort, ergebnisse, provider.name);
  }

  dienste.protokoll?.('Warnung', `Tool-Loop nach ${SCHWELLEN.MAX_TOOL_ITER} Runden abgebrochen (${chatId}).`);
  return '(Die Anfrage hat zu viele Werkzeug-Aufrufe gebraucht und wurde abgebrochen.)';
}

module.exports = { laufe, _haengeToolRundeAn: haengeToolRundeAn };
