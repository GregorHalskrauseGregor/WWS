// Web-Zugriffe: Suche (Tavily) + URL-Fetch (Jina Reader).
// Beide sind optional — wenn die API-Keys fehlen, werfen die Funktionen einen
// klaren Fehler, der im Bot als Tool-Result zurückkommt. Der Bot läuft dann
// einfach ohne Web-Zugriff weiter, die KI weiß dann, dass das Tool grad nicht
// verfügbar ist, und kann das in ihrer Antwort berücksichtigen.

const TAVILY_URL = 'https://api.tavily.com/search';
const JINA_READER_URL = 'https://r.jina.ai/';

// --- web_search -----------------------------------------------------------

// Sucht im Web. Gibt einen kompakten Text-Block zurück, der Titel, URL und
// Snippet pro Treffer enthält. Bewusst text-basiert (kein JSON), damit die
// KI ihn direkt weiterverarbeiten kann.
async function webSearch(query, options = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    throw new Error('TAVILY_API_KEY fehlt in der .env — web_search ist deaktiviert. Key auf https://tavily.com holen (gratis).');
  }
  const maxResults = Math.min(Math.max(options.maxResults || 5, 1), 10);

  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query: String(query || '').slice(0, 500),
      max_results: maxResults,
      // Kein AI-Summary hier — die Antwort soll der Haupt-KI überlassen bleiben.
      include_answer: false,
      // Lieber "advanced" — das sind echte Suchergebnisse, keine Ads.
      search_depth: 'basic',
      // Antworten gerne auf Deutsch, falls das die Locale hergibt.
      topic: 'general'
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Tavily-Fehler: ' + JSON.stringify(data).slice(0, 300));
  }
  if (!Array.isArray(data.results) || data.results.length === 0) {
    return 'Keine Suchergebnisse für: ' + query;
  }

  const zeilen = data.results.map((r, i) => {
    const titel = r.title || '(ohne Titel)';
    const url = r.url || '';
    const snippet = (r.content || '').slice(0, 500);
    return `[${i + 1}] ${titel}\n    ${url}\n    ${snippet}`;
  });
  return `Suchergebnisse für "${query}":\n` + zeilen.join('\n\n');
}

// --- web_fetch ------------------------------------------------------------

// Lädt eine URL und gibt den Inhalt als Markdown zurück. Jina Reader rendert
// auch JS-lastige Seiten serverseitig, daher funktioniert das für die meisten
// Webseiten — auch für Foren, Wikis, Nachrichten, etc.
//
// Defense-in-Depth: URL-Blacklist wird hier ZUSÄTZLICH zu tools.js geprüft,
// damit ein direkter Aufruf von webFetch() (z.B. aus einem Test) auch geschützt ist.
async function webFetch(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('Ungültige URL: ' + url);
  }
  const sicherheit = require('./sicherheit');
  const check = sicherheit.istBlockierteUrl(url);
  if (check.blockiert) {
    throw new Error('URL blockiert: ' + check.grund);
  }
  const key = process.env.JINA_API_KEY;
  const headers = {
    'Accept': 'text/plain',
    'X-Return-Format': 'markdown'
  };
  if (key) headers['Authorization'] = 'Bearer ' + key;

  // Jina erlaubt die URL direkt im Pfad — keine weitere URL-Encodierung nötig
  // außer dem Standard-Pfad-Encoding, das fetch() selbst macht.
  const res = await fetch(JINA_READER_URL + url, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Jina-Reader-Fehler (' + res.status + '): ' + body.slice(0, 300));
  }
  const text = await res.text();
  // Antwort auf ein vernünftiges Maß kürzen, damit die KI nicht in 50k Tokens Markdown ersäuft.
  return text.length > 20000 ? text.slice(0, 20000) + '\n\n[... gekürzt, da zu lang ...]' : text;
}

module.exports = { webSearch, webFetch };
