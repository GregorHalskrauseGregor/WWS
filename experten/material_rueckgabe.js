// Material-Rückgabe-Experte (voll implementiert).
// Dokumentiert Wareneingang / Rückgaben: Material kommt ins Lager.
// Daten aus User-Input (Text, Audio, Foto, Lieferschein) extrahieren,
// mit dem Bestand in material.xlsx abgleichen, an der richtigen Stelle
// addieren oder neue Zeile anlegen.
//
// Designentscheidungen (laut Projekt-Stand):
//   - Eine Zeile pro Artikel (drei Mengenspalten: neu/gebraucht/verschmutzt)
//   - Neue Materialien werden als neue Zeile ans Ende angefügt
//   - Bestehende Positionen werden in der jeweiligen Zustandsspalte erhöht
//   - NIE wird eine Zeile gelöscht (auch nicht bei Bestand 0)

const fs = require('fs');
const material = require('../material');

const MATERIAL_PFAD = material.MATERIAL_PFAD;

// Verarbeitet eine User-Eingabe (oder extrahierten Dokumenteninhalt) und
// gibt eine strukturierte JSON-Antwort mit den Bewegungsdetails zurück.
async function verarbeite(input, kontext) {
  const { text, dokInhalt } = input;
  const userText = (dokInhalt || text || '').trim();
  if (!userText) {
    return { antwort: 'Bitte sag mir, was zurückgegeben wurde: Materialname, Menge, ggf. Einheit und Zustand (neu/gebraucht/verschmutzt).' };
  }

  // KI ruft die Positionen via material.js auf, gibt Bestätigungstext zurück.
  // Wir nutzen hierfür denselben JSON-Extraktor wie der Materialaufmaß-Experte.
  const extrahierte = await extrahiereMaterialien(userText, kontext, 'rueckgabe');

  if (!extrahierte || !Array.isArray(extrahierte.positionen) || extrahierte.positionen.length === 0) {
    return {
      antwort: 'Ich konnte keine Materialpositionen in deiner Nachricht erkennen. Bitte gib an: was, wieviel, ggf. Einheit, ggf. Zustand.\n\nBeispiel: „3 Kugelhähne DN20 gebraucht zurück" oder „2m Kupferrohr 22mm neu".'
    };
  }

  try {
    const ergebnisse = await material.addierePositionen(extrahierte.positionen, MATERIAL_PFAD);
    if (ergebnisse.length === 0) {
      return { antwort: 'Es wurden keine Materialien verarbeitet. Versuch es nochmal mit klarer Angabe.' };
    }
    const text = ergebnisse.map((r) => {
      const zustand = r.zustand ? ` (${r.zustand})` : '';
      const action = r.neu ? '✨ neu angelegt' : `Bestand jetzt ${r.nachher} ${r.einheit}`;
      return `📦 *${r.bezeichnung}*${zustand}: +${r.menge} ${r.einheit} → ${action}`;
    }).join('\n');
    return { antwort: `✅ *Rückgabe verarbeitet:*\n\n${text}\n\n_Datei aktualisiert: data/material.xlsx_` };
  } catch (err) {
    return { antwort: 'Fehler beim Verarbeiten der Rückgabe: ' + err.message };
  }
}

// Markdown-Fallback-Extraktor (lokal, ohne KI-Aufruf) — für einfache Fälle.
function extrahiereAusMarkdown(text) {
  if (!text) return null;
  const positionen = [];
  const norm = (s) => (s || '').toString().trim();

  // Erkenne Zustands-Hinweise: "neu", "gebraucht", "verschmutzt", "Gebrauchte", etc.
  function zustandAusText(t) {
    const tl = t.toLowerCase();
    if (/(gebraucht|gebr\.?|benutzt)/.test(tl)) return 'gebraucht';
    if (/(verschmutzt|schmutzig|dreckig)/.test(tl)) return 'verschmutzt';
    if (/(neu(?!e)|frisch|unbenutzt)/.test(tl)) return 'neu';
    return 'neu'; // Default
  }

  // Verschiedene Zeilen-Patterns:
  // - "3 Stück Kugelhahn DN20 gebraucht"
  // - "12m Kupferrohr 22mm"
  // - "5x Fitting"
  const zeilen = text.split(/[\n;]+/);
  for (const zeileRaw of zeilen) {
    const zeile = zeileRaw.trim();
    if (!zeile || zeile.length < 5) continue;
    // Muster: <Zahl><Einheit?><Material>...
    const m = zeile.match(/^(\d+(?:[,.]\d+)?)\s*(m\b|cm\b|mm\b|stk\.?|stück|st\.?|lfm|kg|liter|l|pauschal)?\s+(.+)/i);
    if (m) {
      const menge = parseFloat(m[1].replace(',', '.'));
      const einheit = m[2] || 'Stk.';
      const rest = m[3].trim();
      const zustand = zustandAusText(rest);
      // Zustand aus Materialname rausfiltern
      const name = rest.replace(/\b(neu|gebraucht|gebr\.?|verschmutzt|schmutzig|dreckig|unbenutzt)\b/gi, '').trim();
      if (name.length > 2) {
        positionen.push({ name, menge, einheit, zustand });
      }
    }
  }
  return positionen.length > 0 ? { positionen } : null;
}

// KI-basierte Extraktion: nutzt die Haupt-KI mit einem Extraktions-Prompt.
async function extrahiereMaterialien(text, kontext, modus) {
  // Erst Markdown-Fallback versuchen (schnell, gratis)
  const mdResult = extrahiereAusMarkdown(text);
  if (mdResult && mdResult.positionen.length > 0) {
    return mdResult;
  }

  // Sonst KI-Aufruf mit JSON-Extraktion
  if (!kontext || !kontext.mainChat) {
    return { positionen: [] };
  }

  const systemPrompt = `Du bist der Material-Extraktor. Deine EINZIGE Aufgabe: aus der Nutzernachricht strukturierte Materialpositionen extrahieren und als JSON zurückgeben.

Modus: ${modus === 'rueckgabe' ? 'RÜCKGABE/WARENEINGANG — Material kommt INS Lager' : 'ENTNAHME/VERBAUCH — Material GEHT RAUS'}

Antworte AUSSCHLIESSLICH mit genau einem JSON-Objekt in dieser Form:
{"positionen": [{"name": "Kupferrohr 22mm", "menge": 12, "einheit": "m", "zustand": "neu", "kategorie": "Rohre & Leitungen"}]}

"zustand" muss "neu", "gebraucht" oder "verschmutzt" sein. "kategorie" muss eine der 12 SHK-Kategorien sein (Rohre & Leitungen, Fittinge & Verbindungstechnik, Armaturen & Ventile, Pumpen & Antriebe, Wärmeerzeugung, Heizkörper & Flächenheizung, Sanitärobjekte, Dämmung & Isolierung, Befestigung & Montagematerial, Elektro & Steuerungstechnik, Werkzeug & Verbrauchsmaterial, Sonstiges). Bei Unsicherheit "Sonstiges".

Falls die Nachricht keine Materialpositionen enthält: {"positionen": []}

Keine Erklärungen, kein Markdown, nur JSON.`;

  try {
    const raw = await kontext.mainChat(systemPrompt, text);
    const md = raw.match(/\{[\s\S]*?\}/);
    if (md) {
      const parsed = JSON.parse(md[0]);
      // Konvertiere in unser Format
      const positionen = (parsed.positionen || []).map((p) => ({
        name: p.name || p.bezeichnung,
        menge: parseFloat(p.menge) || 0,
        einheit: p.einheit || 'Stk.',
        zustand: p.zustand || 'neu',
        kategorie: p.kategorie || 'Sonstiges'
      }));
      return { positionen };
    }
  } catch (e) {
    // Fallback durch
  }
  return { positionen: [] };
}

module.exports = {
  id: 'material_rueckgabe',
  name: 'Material-Rückgabe',
  emoji: '📦',
  description: 'Dokumentiert Material-Rückgaben (Wareneingang): Menge, Zustand (neu/gebraucht/verschmutzt), Materialname, optional Artikelnummer. Daten aus Text, Sprache, Foto, Lieferschein-PDF. Bestand in material.xlsx wird aktualisiert.',
  triggers: [
    'rückgabe', 'rueckgabe', 'zurückbringen', 'zurückgebracht',
    'retoure', 'falschlieferung', 'falsch geliefert',
    'zurück ins lager', 'wieder eingelagert',
    'bringe zurück', 'mitgebracht',
    'wareneingang', 'lieferung', 'geliefert', 'lieferschein',
    'habe bekommen', 'haben bekommen', 'angekommen'
  ],
  systemPromptAdd: `MATERIAL-RÜCKGABE-MODUS AKTIV.
Der User dokumentiert gerade eine Material-Rückgabe / einen Wareneingang. Du erkennst Materialname, Menge, Einheit und Zustand (neu/gebraucht/verschmutzt). Der Bestand in material.xlsx wird entsprechend erhöht — bestehende Positionen in der jeweiligen Zustandsspalte, neue Positionen als neue Zeile.

Wichtig:
- Eine Zeile pro Artikel — die drei Zustands-Spalten (Neu, Gebraucht, Verschmutzt) summieren sich zum Gesamtbestand
- NIE wird eine Zeile gelöscht, auch wenn der Bestand auf 0 fällt
- Spracherkennungsfehler im Diktat sinnvoll korrigieren
- Falls etwas unklar ist (z. B. Zustand), frag einmal nach`,
  tools: null,
  implementiert: true,

  verarbeite,
  extrahiereMaterialien,

  // Optional: Foto/Dokument-Handler, falls eine aktive Rückgabe-Session läuft
  onPhoto: async (chatId, fileId, msg, kontext) => {
    try {
      const link = await kontext.bot.getFileLink(fileId);
      const res = await fetch(link);
      const buf = Buffer.from(await res.arrayBuffer());
      const ocr = require('../ocr');
      const text = await ocr.mistralOCR(buf.toString('base64'), 'image/jpeg');
      const result = await verarbeite({ chatId, text }, kontext);
      return result;
    } catch (err) {
      return { antwort: 'Fehler bei der Foto-Verarbeitung: ' + err.message };
    }
  },
  onDocument: async (chatId, mimeType, fileName, fileId, kontext) => {
    try {
      const link = await kontext.bot.getFileLink(fileId);
      const res = await fetch(link);
      const buf = Buffer.from(await res.arrayBuffer());
      let text = '';
      if (mimeType && mimeType.startsWith('image/')) {
        const ocr = require('../ocr');
        text = await ocr.mistralOCR(buf.toString('base64'), mimeType);
      } else if (mimeType === 'application/pdf') {
        const ocr = require('../ocr');
        text = await ocr.mistralOCR(buf.toString('base64'), mimeType);
      } else if (mimeType && mimeType.includes('spreadsheetml')) {
        const dokument = require('../dokument');
        text = await dokument.excelZuText(buf);
      } else if (mimeType && mimeType.includes('wordprocessingml')) {
        const dokument = require('../dokument');
        text = await dokument.wordZuText(buf);
      } else {
        return { antwort: 'Dateityp wird für Rückgabe-Import nicht unterstützt.' };
      }
      const result = await verarbeite({ chatId, text }, kontext);
      return result;
    } catch (err) {
      return { antwort: 'Fehler bei der Dokument-Verarbeitung: ' + err.message };
    }
  },

  _internals: { verarbeite, extrahiereMaterialien, extrahiereAusMarkdown }
};
