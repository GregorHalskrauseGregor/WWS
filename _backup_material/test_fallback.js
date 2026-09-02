// Testet die Fallback-Ketten-Logik aus bot.js, ohne den Bot selbst zu starten.
// Wir mocken die Provider mit einfachen Stub-Funktionen und prüfen das Verhalten.

const path = require('path');
const { schreibeEintrag } = require('../protokoll');

// Mock-Provider-Funktionen
function mockProvider(name, verhalten) {
  return {
    name,
    rolle: 'main',
    supportsTools: true,
    chat: async (systemPrompt, userMessage, opts) => {
      if (verhalten === 'error_429') {
        throw new Error('Anthropic-API-Fehler: {"status":429,"message":"rate limited"}');
      }
      if (verhalten === 'error_500') {
        throw new Error('OpenAI-API-Fehler: {"status":500,"message":"server error"}');
      }
      if (verhalten === 'error_401') {
        throw new Error('Anthropic-API-Fehler: {"status":401,"message":"invalid api key"}');
      }
      if (verhalten === 'network') {
        const err = new Error('fetch failed');
        err.code = 'ECONNREFUSED';
        throw err;
      }
      if (verhalten === 'ok') {
        return { content: `Antwort von ${name}: ${userMessage}`, toolCalls: null };
      }
      if (verhalten === 'ok_with_tools') {
        return { content: '', toolCalls: [{ id: 'tc1', name: 'web_search', args: { query: 'test' } }] };
      }
      throw new Error('unbekanntes Verhalten: ' + verhalten);
    }
  };
}

// chatMitKette-Funktion (kopiert aus bot.js für den Test)
async function chatMitKette(kette, systemPrompt, userMessage, opts = {}) {
  let letzterFehler = null;
  for (let i = 0; i < kette.length; i++) {
    const provider = kette[i];
    try {
      const r = await provider.chat(systemPrompt, userMessage, { ...opts, rolle: provider.rolle });
      if (i > 0) {
        schreibeEintrag('Info', `Fallback: Antwort kam von "${provider.name}" (Versuch ${i + 1}/${kette.length}). Vorheriger Fehler: ${letzterFehler && letzterFehler.message ? letzterFehler.message.slice(0, 150) : 'unbekannt'}`);
      }
      return r;
    } catch (err) {
      letzterFehler = err;
      if (!istFallbackWuerdig(err) || i === kette.length - 1) {
        throw err;
      }
      console.warn(`Provider ${provider.name} fehlgeschlagen (Fallback-würdig): ${err.message.slice(0, 200)}`);
    }
  }
  throw letzterFehler || new Error('Provider-Kette leer');
}

function istFallbackWuerdig(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' ||
      err.code === 'ECONNRESET' || err.code === 'EAI_AGAIN') return true;
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket hang up')) return true;
  if (/\b(5\d{2})\b/.test(msg)) return true;
  if (/\b429\b/.test(msg)) return true;
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) return true;
  if (/\b(529|503|502|504)\b/.test(msg)) return true;
  return false;
}

(async () => {
  console.log('--- Test 1: Primär antwortet direkt ---');
  const kette1 = [mockProvider('anthropic', 'ok'), mockProvider('openai', 'ok')];
  const r1 = await chatMitKette(kette1, 'sys', 'hallo');
  console.log('Antwort:', r1.content);
  console.log('Erwartet: Antwort von anthropic (Primär, kein Fallback)\n');

  console.log('--- Test 2: Primär wirft 429, Fallback greift ---');
  const kette2 = [mockProvider('anthropic', 'error_429'), mockProvider('openai', 'ok')];
  const r2 = await chatMitKette(kette2, 'sys', 'hallo');
  console.log('Antwort:', r2.content);
  console.log('Erwartet: Antwort von openai (Fallback)\n');

  console.log('--- Test 3: Primär wirft 500, Fallback greift ---');
  const kette3 = [mockProvider('anthropic', 'error_500'), mockProvider('openai', 'ok')];
  const r3 = await chatMitKette(kette3, 'sys', 'hallo');
  console.log('Antwort:', r3.content);
  console.log('Erwartet: Antwort von openai (Fallback)\n');

  console.log('--- Test 4: Primär wirft 401, KEIN Fallback (Auth-Problem) ---');
  const kette4 = [mockProvider('anthropic', 'error_401'), mockProvider('openai', 'ok')];
  try {
    await chatMitKette(kette4, 'sys', 'hallo');
    console.log('Fehler: hätte werfen müssen');
  } catch (err) {
    console.log('Richtig geworfen:', err.message.slice(0, 80));
    console.log('Erwartet: Wirft direkt, weil 401 nicht fallback-würdig\n');
  }

  console.log('--- Test 5: Netzwerk-Fehler auf Primär, Fallback greift ---');
  const kette5 = [mockProvider('anthropic', 'network'), mockProvider('openai', 'ok')];
  const r5 = await chatMitKette(kette5, 'sys', 'hallo');
  console.log('Antwort:', r5.content);
  console.log('Erwartet: Antwort von openai (Fallback wegen ECONNREFUSED)\n');

  console.log('--- Test 6: Beide scheitern, wirft ---');
  const kette6 = [mockProvider('anthropic', 'error_500'), mockProvider('openai', 'error_429')];
  try {
    await chatMitKette(kette6, 'sys', 'hallo');
    console.log('Fehler: hätte werfen müssen');
  } catch (err) {
    console.log('Richtig geworfen (letzter Provider):', err.message.slice(0, 80));
  }

  console.log('--- Test 7: Drei-Glied-Kette, beide ersten scheitern, dritter antwortet ---');
  const kette7 = [
    mockProvider('anthropic', 'error_500'),
    mockProvider('openai', 'error_429'),
    mockProvider('minimax', 'ok')
  ];
  const r7 = await chatMitKette(kette7, 'sys', 'hallo');
  console.log('Antwort:', r7.content);
  console.log('Erwartet: Antwort von minimax (3. Versuch)\n');

  console.log('--- Test 8: Tool-Use-Antwort ---');
  const kette8 = [mockProvider('anthropic', 'ok_with_tools')];
  const r8 = await chatMitKette(kette8, 'sys', 'hallo');
  console.log('Tool-Calls:', JSON.stringify(r8.toolCalls));
  console.log('Erwartet: 1 Tool-Call (web_search)\n');

  console.log('--- Test 9: Fallback-Entscheidung pro Fehlertyp ---');
  console.log('429 wuerdig:', istFallbackWuerdig(new Error('rate limit 429')));
  console.log('500 wuerdig:', istFallbackWuerdig(new Error('internal server error 500')));
  console.log('401 NICHT wuerdig:', istFallbackWuerdig(new Error('invalid api key 401')));
  console.log('400 NICHT wuerdig:', istFallbackWuerdig(new Error('bad request 400')));
  console.log('Timeout wuerdig:', istFallbackWuerdig(new Error('request timed out')));
  console.log('ECONNREFUSED wuerdig:', istFallbackWuerdig(Object.assign(new Error('failed'), { code: 'ECONNREFUSED' })));
})();
