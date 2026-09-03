// Wahl des KI-Anbieters — jetzt pro AUFGABE statt nur "groß/klein".
//
// Vorher gab es zwei Rollen: main und light. Damit konnte man nicht sagen
// "billiges schnelles Modell fürs Routing, starkes fürs Extrahieren".
// Jetzt gibt es Aufgaben-Rollen, die jeweils eigen konfigurierbar sind und
// sinnvoll zurückfallen:
//
//   chat        Antworten an den Nutzer            (Standard: AI_PROVIDER)
//   extraktion  Freitext -> strukturierte Daten    (Standard: AI_PROVIDER)
//   router      Faden- und Experten-Entscheidung   (Standard: AI_PROVIDER_LIGHT)
//   summary     Zusammenfassen, Gedächtnis pflegen (Standard: AI_PROVIDER_LIGHT)
//
// Konfiguration je Rolle (alles optional):
//   AI_PROVIDER_ROUTER=openai
//   OPENAI_MODEL_ROUTER=gpt-4o-mini
//
// Fallback-Kette bei Ausfall eines Anbieters:
//   AI_FALLBACK_KETTE=openai,minimax
//
// Damit ist der Bot nicht an einen Anbieter gebunden: fällt einer aus oder wird
// teuer, ist das ein Eintrag in der .env, kein Code-Umbau.

const { schreibeEintrag } = require('../protokoll');

const anbieter = {
  anthropic: require('./anthropic'),
  openai: require('./openai'),
  minimax: require('./minimax')
};

// leicht = Aufgabe im Hintergrund, darf ein kleineres Modell nutzen
const ROLLEN = {
  chat: { leicht: false },
  extraktion: { leicht: false },
  router: { leicht: true },
  summary: { leicht: true },
  // Rückwärtskompatibel — alter Code ruft weiter main/light
  main: { leicht: false },
  light: { leicht: true }
};

function env(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function anbieterNameFuer(rolle) {
  const gross = String(rolle).toUpperCase();
  const leicht = (ROLLEN[rolle] || ROLLEN.chat).leicht;
  return env(`AI_PROVIDER_${gross}`)
    || (leicht ? env('AI_PROVIDER_LIGHT') : null)
    || env('AI_PROVIDER')
    || 'anthropic';
}

function modellFuer(anbieterName, rolle) {
  return env(`${anbieterName.toUpperCase()}_MODEL_${String(rolle).toUpperCase()}`) || null;
}

function hole(name, rolle) {
  const modul = anbieter[name];
  if (!modul) {
    throw new Error(
      `Unbekannter KI-Anbieter "${name}" (Rolle: ${rolle}). Erlaubt: ${Object.keys(anbieter).join(', ')}`
    );
  }
  return modul;
}

function fallbackKette(primaer) {
  return (env('AI_FALLBACK_KETTE') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== primaer && anbieter[s]);
}

// Fehler, bei denen ein anderer Anbieter helfen kann (Ausfall, Limit, Timeout).
// Ein Programmierfehler soll NICHT stillschweigend weiterreichen.
function lohntFallback(err) {
  const t = String(err && err.message || '');
  return /(\b429\b|\b5\d\d\b|rate.?limit|overloaded|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed)/i.test(t);
}

// Liefert ein Provider-Objekt mit derselben Schnittstelle wie bisher:
//   chat(systemPrompt, userMessage, options) -> { content, toolCalls }
function getProvider(rolle = 'chat') {
  if (!ROLLEN[rolle]) rolle = 'chat';
  const leicht = ROLLEN[rolle].leicht;
  const primaerName = anbieterNameFuer(rolle);
  const primaer = hole(primaerName, rolle);
  const kette = [primaerName, ...fallbackKette(primaerName)];

  async function chat(systemPrompt, userMessage, options = {}) {
    let letzterFehler;
    for (let i = 0; i < kette.length; i++) {
      const name = kette[i];
      const modul = anbieter[name];
      const opts = {
        ...options,
        rolle: options.rolle || (leicht ? 'light' : 'main'),
        model: options.model || modellFuer(name, rolle) || undefined
      };
      try {
        const antwort = await modul.chat(systemPrompt, userMessage, opts);
        if (i > 0) {
          schreibeEintrag('Info',
            `Fallback: Antwort kam von "${name}" (Versuch ${i + 1}/${kette.length}). ` +
            `Vorher: ${String(letzterFehler && letzterFehler.message).slice(0, 150)}`);
        }
        return antwort;
      } catch (err) {
        letzterFehler = err;
        const nochWer = i < kette.length - 1;
        if (!nochWer || !lohntFallback(err)) throw err;
        console.warn(`Anbieter ${name} fehlgeschlagen, versuche nächsten: ${err.message.slice(0, 200)}`);
      }
    }
    throw letzterFehler;
  }

  return {
    chat,
    name: primaerName,
    rolle,
    supportsTools: primaer.supportsTools !== false,
    kette
  };
}

// Für /dienste und den Start-Log
function uebersicht() {
  return Object.keys(ROLLEN)
    .filter((r) => !['main', 'light'].includes(r))
    .map((r) => {
      const name = anbieterNameFuer(r);
      return { rolle: r, anbieter: name, modell: modellFuer(name, r) || 'Modell-Standard' };
    });
}

module.exports = { getProvider, uebersicht, ROLLEN, _lohntFallback: lohntFallback };
