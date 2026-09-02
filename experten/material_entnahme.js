// Material-Entnahme-Experte (voll implementiert).
// Dokumentiert Material-Entnahmen: Material geht aus dem Lager raus (Verbrauch).
// Daten aus User-Input (Text, Audio, Foto, Lieferschein) extrahieren,
// Bestand in material.xlsx anpassen. Bestandsschutz: nie negativ.

const fs = require('fs');
const material = require('../material');

const MATERIAL_PFAD = material.MATERIAL_PFAD;

async function verarbeite(input, kontext) {
  const { text, dokInhalt } = input;
  const userText = (dokInhalt || text || '').trim();
  if (!userText) {
    return { antwort: 'Bitte sag mir, was entnommen wurde: Materialname, Menge, ggf. Einheit, optional Auftrag/Bauvorhaben.' };
  }

  const extrahierte = await extrahiereMaterialien(userText, kontext, 'entnahme');

  if (!extrahierte || !Array.isArray(extrahierte.positionen) || extrahierte.positionen.length === 0) {
    return {
      antwort: 'Ich konnte keine Materialpositionen in deiner Nachricht erkennen. Bitte gib an: was, wieviel, ggf. Einheit.\n\nBeispiel: „2 Wandscheiben DN20 entnommen" oder „5m Kupferrohr 22mm verbraucht".'
    };
  }

  try {
    const ergebnisse = await material.entnehmePositionen(extrahierte.positionen, MATERIAL_PFAD);
    if (ergebnisse.length === 0) {
      return { antwort: 'Es wurden keine Materialien verarbeitet. Versuch es nochmal mit klarer Angabe.' };
    }
    const zeilen = ergebnisse.map((r) => {
      if (r.unbekannt) return `⚠️ *${r.bezeichnung}*: war nicht im Lager.`;
      const fehlt = r.fehlend > 0 ? ` (Fehlmenge: ${r.fehlend} ${r.einheit})` : '';
      return `🔧 *${r.bezeichnung}* (${r.zustand || 'neu'}): ${r.entnommen} ${r.einheit} entnommen, Restbestand ${r.nachher}${fehlt}`;
    });
    return { antwort: `✅ *Entnahme verarbeitet:*\n\n${zeilen.join('\n')}\n\n_Datei aktualisiert: data/material.xlsx_` };
  } catch (err) {
    return { antwort: 'Fehler beim Verarbeiten der Entnahme: ' + err.message };
  }
}

function zustandAusText(t) {
  const tl = t.toLowerCase();
  if (/(gebraucht|gebr\.?|benutzt)/.test(tl)) return 'gebraucht';
  if (/(verschmutzt|schmutzig|dreckig)/.test(tl)) return 'verschmutzt';
  return 'neu';
}

function extrahiereAusMarkdown(text) {
  if (!text) return null;
  const positionen = [];
  const zeilen = text.split(/[\n;]+/);
  for (const zeileRaw of zeilen) {
    const zeile = zeileRaw.trim();
    if (!zeile || zeile.length < 5) continue;
    const m = zeile.match(/^(\d+(?:[,.]\d+)?)\s*(m\b|cm\b|mm\b|stk\.?|stück|st\.?|lfm|kg|liter|l|pauschal)?\s+(.+)/i);
    if (m) {
      const menge = parseFloat(m[1].replace(',', '.'));
      const einheit = m[2] || 'Stk.';
      const rest = m[3].trim();
      const zustand = zustandAusText(rest);
      const name = rest.replace(/\b(neu|gebraucht|gebr\.?|verschmutzt|schmutzig|dreckig|unbenutzt)\b/gi, '').trim();
      if (name.length > 2) {
        positionen.push({ name, menge, einheit, zustand });
      }
    }
  }
  return positionen.length > 0 ? { positionen } : null;
}

async function extrahiereMaterialien(text, kontext, modus) {
  const mdResult = extrahiereAusMarkdown(text);
  if (mdResult && mdResult.positionen.length > 0) {
    return mdResult;
  }

  if (!kontext || !kontext.mainChat) {
    return { positionen: [] };
  }

  const systemPrompt = `Du bist der Material-Extraktor. Deine EINZIGE Aufgabe: aus der Nutzernachricht strukturierte Materialpositionen extrahieren und als JSON zurückgeben.

Modus: ENTNAHME/VERBRAUCH — Material GEHT AUS dem Lager raus

Antworte AUSSCHLIESSLICH mit genau einem JSON-Objekt in dieser Form:
{"positionen": [{"name": "Kupferrohr 22mm", "menge": 12, "einheit": "m", "zustand": "neu"}]}

"zustand" muss "neu", "gebraucht" oder "verschmutzt" sein (Default: "neu").

Falls die Nachricht keine Materialpositionen enthält: {"positionen": []}

Keine Erklärungen, kein Markdown, nur JSON.`;

  try {
    const raw = await kontext.mainChat(systemPrompt, text);
    const md = raw.match(/\{[\s\S]*?\}/);
    if (md) {
      const parsed = JSON.parse(md[0]);
      const positionen = (parsed.positionen || []).map((p) => ({
        name: p.name || p.bezeichnung,
        menge: parseFloat(p.menge) || 0,
        einheit: p.einheit || 'Stk.',
        zustand: p.zustand || 'neu'
      }));
      return { positionen };
    }
  } catch (e) {}
  return { positionen: [] };
}

module.exports = {
  id: 'material_entnahme',
  name: 'Material-Entnahme',
  emoji: '🔧',
  description: 'Dokumentiert Material-Entnahmen aus dem Lager (Verbrauch). Daten aus Text, Sprache, Foto, Lieferschein-PDF. Bestand in material.xlsx wird reduziert, mit Bestandsschutz (nie negativ).',
  triggers: [
    'entnahme', 'entnehme', 'entnehmen', 'entnommen',
    'nehme', 'nehmen',
    'verbrauche', 'verbraucht', 'verbrauch',
    'verbaue', 'verbaut', 'verbau', 'verbaut',
    'hole material', 'nehme mit', 'mitgenommen', 'mitzunehmen',
    'bestand sinkt', 'abgang', 'aus dem lager',
    'abgang', 'entgangen'
  ],
  systemPromptAdd: `MATERIAL-ENTNAHME-MODUS AKTIV.
Der User dokumentiert gerade eine Material-Entnahme: Material geht aus dem Lager raus (Verbrauch). Du erkennst Materialname, Menge und optional Einheit. Der Bestand in material.xlsx wird entsprechend reduziert.

Wichtig:
- Bestandsschutz: Bestand kann nie negativ werden (deckelt bei 0, Fehlmenge wird gemeldet)
- Position muss im Lager existieren, sonst klare Fehlermeldung
- Eine Zeile pro Artikel — die jeweilige Zustandsspalte (Neu/Gebraucht/Verschmutzt) wird reduziert
- NIE wird eine Zeile gelöscht
- Falls etwas unklar ist, frag einmal nach`,
  tools: null,
  implementiert: true,

  verarbeite,
  extrahiereMaterialien,

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
        return { antwort: 'Dateityp wird für Entnahme-Import nicht unterstützt.' };
      }
      const result = await verarbeite({ chatId, text }, kontext);
      return result;
    } catch (err) {
      return { antwort: 'Fehler bei der Dokument-Verarbeitung: ' + err.message };
    }
  },

  _internals: { verarbeite, extrahiereMaterialien, extrahiereAusMarkdown }
};
