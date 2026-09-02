// Reproduziert den Loop-Bug und verifiziert den Fix.
// Wir simulieren den Tool-Loop mit MiniMax und schauen, ob die Tool-Results
// korrekt in den Messages landen (vorher waren sie's nicht → Endlosschleife).

function messagesAktualisierenAlt(messages, antwort, toolResults, providerName) {
  if (providerName === 'anthropic') {
    messages.push({
      role: 'assistant',
      content: antwort.toolCalls.map((c) => ({
        type: 'tool_use', id: c.id, name: c.name, input: c.args
      }))
    });
    messages.push({
      role: 'user',
      content: toolResults.map((r) => ({
        type: 'tool_result', tool_use_id: r.id, content: r.result
      }))
    });
  } else if (providerName === 'openai') {
    messages.push({
      role: 'assistant',
      content: antwort.content || null,
      tool_calls: antwort.toolCalls.map((c) => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) }
      }))
    });
    for (const r of toolResults) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
    }
  } else {
    // Sollte nicht passieren, weil Provider ohne Tool-Support gar keine Calls liefern.
  }
}

function messagesAktualisierenFix(messages, antwort, toolResults, providerName) {
  if (providerName === 'anthropic') {
    messages.push({
      role: 'assistant',
      content: antwort.toolCalls.map((c) => ({
        type: 'tool_use', id: c.id, name: c.name, input: c.args
      }))
    });
    messages.push({
      role: 'user',
      content: toolResults.map((r) => ({
        type: 'tool_result', tool_use_id: r.id, content: r.result
      }))
    });
  } else if (providerName === 'openai' || providerName === 'minimax') {
    messages.push({
      role: 'assistant',
      content: antwort.content || null,
      tool_calls: antwort.toolCalls.map((c) => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) }
      }))
    });
    for (const r of toolResults) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
    }
  }
}

const antwort = {
  content: null,
  toolCalls: [{ id: 'minimax-tc-0-12345', name: 'web_search', args: { query: 'Wetter Berlin heute' } }]
};
const toolResults = [{ id: 'minimax-tc-0-12345', name: 'web_search', result: 'Wetter Berlin: 22°C, sonnig' }];

console.log('--- Vorher (Bug): messagesAktualisieren mit MiniMax tat NICHTS ---');
const messagesAlt = [{ role: 'user', content: 'suche nach wetter' }];
messagesAktualisierenAlt(messagesAlt, antwort, toolResults, 'minimax');
console.log('Anzahl Messages nach Tool-Result:', messagesAlt.length, '(erwartet: 3, tat: 1)');
console.log('→ Das Modell sah die Tool-Results NICHT → machte neuen Tool-Call → Endlosschleife');
console.log('');

console.log('--- Nachher (Fix): MiniMax wird wie OpenAI behandelt ---');
const messagesFix = [{ role: 'user', content: 'suche nach wetter' }];
messagesAktualisierenFix(messagesFix, antwort, toolResults, 'minimax');
console.log('Anzahl Messages nach Tool-Result:', messagesFix.length, '(erwartet: 3)');
console.log('Messages-Struktur:');
messagesFix.forEach((m, i) => {
  const summary = JSON.stringify(m).slice(0, 120);
  console.log(`  [${i}] role=${m.role} ${summary}`);
});
console.log('');
console.log('→ Tool-Result ist als "role: tool" mit tool_call_id drin. Modell sieht es und formuliert die finale Antwort.');
