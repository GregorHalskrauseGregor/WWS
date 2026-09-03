// Registry für alle Experten-Module. Lädt automatisch alle .js-Dateien
// aus diesem Ordner (außer dieser Index-Datei und der _template.js) und
// stellt Funktionen zur Verfügung.
//
// KI-basierte Experten-Auswahl (neu, ersetzt reine Schlüsselwort-Suche):
//   waehleExpertenMitKI(text, kontext) → Experte | null
// Berücksichtigt: aktive Sessions + Beschreibung der implementierten Experten +
// die User-Nachricht. Die KI entscheidet selbst, statt auf generische Trigger-Wörter
// zu matchen (was zu Fehlleitungen führte, z.B. "brauche Anleitung" → Bestellung).
//
// Stubs (implementiert: false) werden weiter geladen und in /experten angezeigt,
// aber NICHT der KI zur Auswahl gegeben — sie können also nicht mehr fälschlich
// aktiviert werden, solange sie nicht implementiert sind.

const fs = require('fs');
const path = require('path');

const EXPERTEN_ORDNER = __dirname;

// Schwarze Liste: diese Dateien NICHT als Experten laden
const IGNORIEREN = new Set(['index.js', '_template.js']);

function ladeExperten() {
  const dateien = fs.readdirSync(EXPERTEN_ORDNER, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js') && !IGNORIEREN.has(d.name))
    .map((d) => d.name);

  const experten = [];
  const fehler = [];
  for (const datei of dateien) {
    const pfad = path.join(EXPERTEN_ORDNER, datei);
    try {
      const modul = require(pfad);
      const pflicht = ['id', 'name', 'description', 'triggers', 'systemPromptAdd', 'verarbeite', 'implementiert'];
      for (const feld of pflicht) {
        if (modul[feld] === undefined) {
          throw new Error(`Pflichtfeld "${feld}" fehlt in ${datei}`);
        }
      }
      experten.push({ ...modul, _datei: datei });
    } catch (err) {
      fehler.push({ datei, fehler: err.message });
    }
  }
  if (fehler.length > 0) {
    console.warn('Experten-Module mit Lade-Fehlern:');
    for (const f of fehler) console.warn(`  ${f.datei}: ${f.fehler}`);
  }
  return experten;
}

function _expertenCache() {
  if (!_expertenCache._cache) {
    _expertenCache._cache = ladeExperten();
  }
  return _expertenCache._cache;
}

// Nur implementierte Experten — Stubs werden für die Auto-Auswahl ignoriert.
function implementierteExperten() {
  return _expertenCache().filter((e) => e.implementiert);
}

// Vollständige Liste (inkl. Stubs) — für /experten-Command
function alleExperten() {
  return _expertenCache();
}

// Prüft, ob ein Experte eine aktive Session für diesen User hat.
// Wird vom Bot VOR der Trigger-Erkennung aufgerufen, damit laufende Erfassungen
// (z.B. Materialaufmaß) nicht durch Trigger-freie Wörter ("fertig", "pdf bitte", "ändere Position 2")
// unterbrochen werden.
function aktiverExperte(chatId) {
  for (const e of _expertenCache()) {
    if (typeof e.hatAktiveSession === 'function') {
      try {
        if (e.hatAktiveSession(chatId)) return e;
      } catch { /* defensiv */ }
    }
  }
  return null;
}

// Findet den passendsten Experten für eine Nachricht via Trigger-Wörter.
// (Falls die KI-Auswahl nicht will oder nicht verfügbar ist, Fallback.)
// WICHTIG: Stubs werden übersprungen, damit nicht-implementierte Experten
// nicht versehentlich aktiviert werden.
function findeExperte(text) {
  if (!text || typeof text !== 'string') return null;
  const norm = text.toLowerCase();
  const experten = implementierteExperten(); // <— nur implementierte!
  let bester = null;
  let bestePunkte = 0;
  for (const e of experten) {
    let punkte = 0;
    for (const trig of e.triggers) {
      const t = String(trig).toLowerCase();
      if (!t) continue;
      if (norm.includes(t)) punkte += t.length;
    }
    if (punkte > bestePunkte) {
      bestePunkte = punkte;
      bester = e;
    }
  }
  return bester;
}

// Direkt nach ID suchen (z.B. /experte materialaufmass)
function findeExperteMitId(id) {
  return _expertenCache().find((e) => e.id === id) || null;
}

// Übersicht für /experten-Command
function listeStatus() {
  return _expertenCache().map((e) => ({
    id: e.id,
    name: e.name,
    emoji: e.emoji || '·',
    description: e.description,
    triggers: e.triggers,
    implementiert: e.implementiert,
    datei: e._datei
  }));
}

// ----------------------------------------------------------------------
// KI-basierte Experten-Auswahl
// ----------------------------------------------------------------------
//
// Statt auf generische Trigger-Wörter zu matchen, fragen wir die KI selbst,
// welcher Experte zur aktuellen User-Nachricht passt. Die KI bekommt:
//   - die User-Nachricht
//   - eine Liste der verfügbaren (implementierten) Experten mit Beschreibung
//   - aktive Sessions (falls vorhanden, mit Kontext)
//   - den aktuellen Themen-Verlauf (letzte Nachrichten, für Kontext)
//
// Sie antwortet mit JSON: { "experte": "id" | null, "confidence": 0.0-1.0, "grund": "..." }
//
// Wir vertrauen der Entscheidung nur, wenn confidence >= 0.7. Sonst null
// (= Standard-Chat, kein Experte aktiv).

async function waehleExpertenMitKI({ text, chatId, kontext }) {
  if (!text || !kontext || !kontext.mainChat) return null;

  // 1. Liste implementierter Experten (Stubs gefiltert)
  const experten = implementierteExperten();
  if (experten.length === 0) return null;

  // 2. Aktive Sessions zusammenstellen
  const aktiveSessions = [];
  for (const e of experten) {
    if (typeof e.hatAktiveSession === 'function') {
      try {
        if (e.hatAktiveSession(chatId)) {
          aktiveSessions.push({
            experte: e.id,
            name: e.name,
            emoji: e.emoji
          });
        }
      } catch { /* defensiv */ }
    }
  }

  // 3. Den Verlauf des aktuellen Themas (falls vorhanden) — nur die letzten paar Messages
  let verlaufSnippet = '';
  if (kontext.ladeThemenVerlauf) {
    try {
      const verlauf = await kontext.ladeThemenVerlauf(chatId, 4);
      if (verlauf && verlauf.length > 0) {
        verlaufSnippet = verlauf
          .map((m) => `${m.rolle === 'user' ? 'User' : 'Bot'}: ${m.inhalt}`)
          .join('\n');
        // Auf max. 600 Zeichen kürzen, damit der Kontext-Prompt nicht explodiert
        if (verlaufSnippet.length > 600) {
          verlaufSnippet = '...' + verlaufSnippet.slice(-600);
        }
      }
    } catch { /* defensiv */ }
  }

  // 4. System-Prompt für die KI
  const expertenListe = experten.map((e) => {
    const triggerBeispiel = (e.triggers || []).slice(0, 4).join(', ');
    return `- ${e.id}: ${e.name} ${e.emoji || ''} — ${e.description} (Beispiel-Trigger: ${triggerBeispiel})`;
  }).join('\n');

  let kontextBlock = '';
  if (aktiveSessions.length > 0) {
    kontextBlock = `\n\nAKTIVE SESSION:\nEs läuft gerade eine Erfassung für: ${aktiveSessions.map((s) => `${s.emoji || ''} ${s.name} (${s.experte})`).join(', ')}. Wenn die aktuelle Nachricht zu dieser Session passt (z.B. eine Anpassung oder eine Bestätigung), gib diese Session zurück.`;
  }
  if (verlaufSnippet) {
    kontextBlock += `\n\nLETZTE NACHRICHTEN:\n${verlaufSnippet}`;
  }

  const systemPrompt = `Du bist der Experten-Router für einen Handwerker-Bot. Wähle aus den verfügbaren Experten den passenden für die User-Nachricht — oder null, wenn es eine normale Konversation ist.

VERFÜGBARE EXPERTEN:
${expertenListe}
${kontextBlock}

WICHTIG:
- Wähle den Experten NUR, wenn die User-Nachricht klar zu seinem Zweck passt.
- Generische Begriffe wie "brauche", "Anleitung", "Leistung" sind KEIN automatischer Trigger — interpretiere sie im Kontext:
  * "höchste Leistung in Kategorie" = technische Eigenschaft, kein Rechnungs-Trigger
  * "brauche eine Anleitung" = Recherche, nicht Bestellung
  * "Suche im Netz nach Anleitung" = Recherche, nicht Materialaufmaß
- Bei Unsicherheit: null zurückgeben. Lieber keine Aktion als die falsche.
- Bei aktiver Session: wenn die Nachricht eine Anpassung oder Bestätigung ist (z.B. "ändere Position 2 auf 5", "fertig", "passt"), gib diese Session zurück.

Antworte AUSSCHLIESSLICH mit genau einem JSON-Objekt in dieser Form:
{"experte": "id-oder-null", "confidence": 0.0-1.0, "grund": "kurze Begründung in 1 Satz"}

Keine Erklärungen, kein Markdown, nur JSON.`;

  try {
    const raw = await kontext.mainChat(systemPrompt, text);
    // JSON aus dem Output extrahieren (robust gegen Markdown-Wrapping)
    const mdMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    const jsonStr = mdMatch ? mdMatch[1] : raw.match(/\{[\s\S]*?\}/)?.[0];
    if (!jsonStr) return null;
    const parsed = JSON.parse(jsonStr);

    // Nur vertrauen, wenn die Konfidenz hoch genug ist
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0.7) {
      return null;
    }
    if (!parsed.experte) return null;

    // ID muss zu einem implementierten Experten gehören
    const experte = experten.find((e) => e.id === parsed.experte);
    if (!experte) return null;

    return experte;
  } catch (err) {
    console.error('Experten-Auswahl (KI) fehlgeschlagen:', err.message);
    return null;
  }
}

module.exports = {
  ladeExperten,
  implementierteExperten,
  findeExperte,
  findeExperteMitId,
  aktiverExperte,
  waehleExpertenMitKI,
  listeStatus
};
