// Router-KI: entscheidet VOR allem anderen, was mit einer User-Nachricht passieren soll.
// Ersetzt die alte Trigger-Wort-Erkennung komplett. Die KI bekommt die volle Situation
// (Text, ggf. Datei-Infos, aktive Sessions, Experten-Liste, Verlauf) und antwortet
// mit einer Routing-Entscheidung als JSON.
//
// Mögliche Aktionen:
//   "verarbeiten"       — Experte wird aktiviert und bekommt die Nachricht
//   "vorlage_speichern"  — Datei ist eine Vorlage, wird unter data/aufnahme_vorlage/ abgelegt
//   "style_speichern"    — Datei ist ein Style-Sheet, wird unter data/style_sheet/ abgelegt
//   "dokument_speichern" — Datei ist nur ein Anhang, keine weitere Verarbeitung
//   "konversation"       — Standard-Chat, kein Experte nötig
//   "nachfragen"         — Anfrage zu unklar, Bot soll nachfragen
//
// Aufgerufen aus: bot.js → verarbeiteText (Text) und bot.on('message') (Foto/Dokument)

const fs = require('fs');
const experten = require('../experten');

function defaultEntscheidung(aktion, hinweis, confidence) {
  return {
    aktion,
    experte: null,
    dok_typ: null,
    hinweis: hinweis || null,
    confidence: confidence != null ? confidence : 0.0
  };
}

function systemPromptFuerRouter(expertenBeschreibung, aktiveSessions, verlaufSnippet) {
  let block = `Du bist der Router für einen Handwerker-Bot. Du bekommst eine User-Nachricht (ggf. mit angehängter Datei) und musst entscheiden, was damit passieren soll.

VERFÜGBARE AKTIONEN:
- "verarbeiten": Die Nachricht (und ggf. die Datei) soll von einem Experten verarbeitet werden. Setze "experte" auf den passenden.
- "vorlage_speichern": Die angehängte Datei ist eine Vorlage (z.B. ein leeres Formular zum Ausfüllen). Speichere sie unter data/aufnahme_vorlage/.
- "style_speichern": Die angehängte Datei ist ein Style-Sheet / Formatvorlage. Speichere sie unter data/style_sheet/.
- "dokument_speichern": Die Datei ist ein Anhang, der nur abgelegt werden soll (z.B. ein Lieferschein-Bild zur Ablage).
- "konversation": Normale Konversation. Kein Experte nötig. Bot soll direkt antworten.
- "nachfragen": Die Anfrage ist unklar oder mehrdeutig. Bot soll kurz nachfragen.

VERFÜGBARE EXPERTEN (implementiert — die anderen sind Stubs und NICHT wählbar):
${expertenBeschreibung}

WICHTIGE REGELN:
- Generische Wörter wie "brauche", "Anleitung", "Leistung" sind KEIN automatischer Trigger. Interpretiere sie im Kontext:
    "höchste Leistung in Kategorie" = technische Eigenschaft, kein Rechnungs-Trigger
    "ich brauche eine Anleitung" = Recherche nach Anleitung
    "ich sende gleich X" = Ankündigung, KEINE Aktion jetzt
- Bei aktiver Materialaufmaß-Session: erkennt explizit Bestätigungen und Anpassungen:
    "ändere Position X auf Y", "Position X raus", "X statt Y", "Position X umbenennen" → Anpassung, gib materialaufmass zurück
    "fertig", "passt", "ok", "stimmt", "richtig", "PDF", "jetzt zum pdf", "zum pdf bitte", "erstelle das PDF", "mache das PDF" → Bestätigung, gib materialaufmass zurück (zeigt dann den PDF-Button)
    "X mehr", "noch X", "X dazu", "ergänze X", "fehlt X" → Ergänzung, gib materialaufmass zurück
- Bei einer Datei: beachte den Dateinamen und (falls vorhanden) den Inhalt.
    Dateiname enthält "aufmaß" + Formular/leere Felder → vorlage_speichern
    Dateiname enthält "lieferschein" / "rechnung" + echte Daten → verarbeiten (Material-Rückgabe/Entnahme, je nach Kontext)
- "Außerbetriebnahme", "Reparatur", "Wartung" sind KEINE Aufmaße — sie fallen meist in Konversation.
- Bei Unsicherheit: "konversation" mit niedriger confidence. Lieber nichts tun als das Falsche.
- Confidence < 0.6: Bot macht nichts (= Standard-Chat). Confidence >= 0.6: Aktion wird ausgeführt.

Antworte AUSSCHLIESSLICH mit genau einem JSON-Objekt in dieser Form (ohne Markdown, ohne Erklärungen):

{
  "aktion": "verarbeiten" | "vorlage_speichern" | "style_speichern" | "dokument_speichern" | "konversation" | "nachfragen",
  "experte": "recherche" | "materialaufmass" | "material_rueckgabe" | "material_entnahme" | null,
  "dok_typ": "daten" | "vorlage" | "anhaenger" | null,
  "hinweis": "string oder null",
  "confidence": 0.0-1.0
}`;

  if (aktiveSessions.length > 0) {
    block += `\n\nAKTIVE SESSION: Es läuft gerade eine Erfassung für: ${aktiveSessions.map((s) => `${s.emoji || ''} ${s.name} (${s.id})`).join(', ')}. Wenn die aktuelle Nachricht zu dieser Erfassung passt (z.B. eine Anpassung oder Bestätigung), wähle "verarbeiten" mit dem passenden Experten.`;
  }
  if (verlaufSnippet) {
    block += `\n\nLETZTE NACHRICHTEN:\n${verlaufSnippet}`;
  }
  return block;
}

function parseJsonAusAntwort(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Versuche zuerst Markdown-Codeblock
  const mdMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (mdMatch) {
    try { return JSON.parse(mdMatch[1]); } catch { /* fallthrough */ }
  }
  // Sonst roher JSON-Block
  const rawMatch = raw.match(/\{[\s\S]*?\}/);
  if (rawMatch) {
    const kandidaten = raw.match(/\{[\s\S]*?\}/g) || [];
    for (let i = kandidaten.length - 1; i >= 0; i--) {
      try { return JSON.parse(kandidaten[i]); } catch { /* nächsten probieren */ }
    }
  }
  return null;
}

// Liest die ersten ~500 Zeichen einer Datei (als Vorschau für die Router-KI).
async function dateiVorschau(dokInfo) {
  if (!dokInfo || !dokInfo.pfad) return null;
  try {
    const stat = fs.statSync(dokInfo.pfad);
    if (stat.size > 500000) return null; // zu groß für Vorschau
    const buffer = fs.readFileSync(dokInfo.pfad);
    // PDF → per pdf-parse (lazy) Text extrahieren
    if (dokInfo.mimeType === 'application/pdf' || dokInfo.name && dokInfo.name.toLowerCase().endsWith('.pdf')) {
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        return (data.text || '').slice(0, 500);
      } catch { return null; }
    }
    // Text-Dateien direkt
    if (dokInfo.mimeType && dokInfo.mimeType.startsWith('text/')) {
      return buffer.toString('utf-8').slice(0, 500);
    }
    return null;
  } catch { return null; }
}

async function routingEntscheidung({ text, dokInfo, chatId, kontext }) {
  if (!kontext || !kontext.mainChat) {
    return defaultEntscheidung('konversation', 'mainChat nicht verfügbar', 0.0);
  }
  if (!text && !dokInfo) {
    return defaultEntscheidung('konversation', 'leere Eingabe', 0.0);
  }

  // 1. Liste implementierter Experten (Stubs sind gefiltert)
  const expertenListe = experten.implementierteExperten();
  if (expertenListe.length === 0) {
    return defaultEntscheidung('konversation', 'keine Experten verfügbar', 0.0);
  }
  const expertenBeschreibung = expertenListe.map((e) => {
    return `- ${e.id} (${e.emoji || ''} ${e.name}): ${e.description}`;
  }).join('\n');

  // 2. Aktive Sessions
  const aktiveSessions = [];
  for (const e of expertenListe) {
    if (typeof e.hatAktiveSession === 'function') {
      try {
        if (e.hatAktiveSession(chatId)) {
          aktiveSessions.push({ id: e.id, name: e.name, emoji: e.emoji });
        }
      } catch { /* defensiv */ }
    }
  }

  // 3. Verlauf des jüngsten Themas
  let verlaufSnippet = '';
  if (kontext.letzteNachrichten) {
    try {
      const verlauf = await kontext.letzteNachrichten(chatId, 4);
      if (verlauf && verlauf.length > 0) {
        verlaufSnippet = verlauf
          .map((m) => `${m.rolle === 'user' ? 'User' : 'Bot'}: ${m.inhalt}`)
          .join('\n');
        if (verlaufSnippet.length > 600) {
          verlaufSnippet = '...' + verlaufSnippet.slice(-600);
        }
      }
    } catch { /* defensiv */ }
  }

  // 4. Datei-Vorschau (optional)
  let vorschau = null;
  if (dokInfo) {
    vorschau = await dateiVorschau(dokInfo);
  }

  // 5. Eingabe für die KI zusammenbauen
  const eingabeTeile = [];
  if (text) eingabeTeile.push('USER-NACHRICHT:\n' + text);
  if (dokInfo) {
    const d = dokInfo;
    eingabeTeile.push(
      'ANGEHÄNGTE DATEI:\n' +
      '- Dateiname: ' + (d.name || '(unbekannt)') + '\n' +
      '- MIME-Type: ' + (d.mimeType || '(unbekannt)') + '\n' +
      '- Größe: ' + (d.size != null ? d.size + ' Bytes' : '(unbekannt)') + '\n' +
      (vorschau ? '- Inhalt (erste 500 Zeichen):\n' + vorschau : '')
    );
  }
  const eingabe = eingabeTeile.join('\n\n');

  // 6. System-Prompt + KI-Aufruf
  const systemPrompt = systemPromptFuerRouter(expertenBeschreibung, aktiveSessions, verlaufSnippet);

  try {
    const raw = await kontext.mainChat(systemPrompt, eingabe);
    const parsed = parseJsonAusAntwort(raw);
    if (!parsed || typeof parsed !== 'object') {
      return defaultEntscheidung('konversation', 'KI lieferte kein gültiges JSON', 0.0);
    }

    // Validierung
    const erlaubteAktionen = ['verarbeiten', 'vorlage_speichern', 'style_speichern', 'dokument_speichern', 'konversation', 'nachfragen'];
    if (!erlaubteAktionen.includes(parsed.aktion)) {
      return defaultEntscheidung('konversation', 'unbekannte Aktion: ' + parsed.aktion, 0.0);
    }
    if (parsed.aktion === 'verarbeiten') {
      const erlaubteExperten = expertenListe.map((e) => e.id);
      if (!erlaubteExperten.includes(parsed.experte)) {
        // KI hat einen Stub oder unbekannten Experten gewählt → konversation
        return defaultEntscheidung('konversation', 'KI wählte ungültigen Experten: ' + parsed.experte, 0.0);
      }
    }
    // Confidence-Schwelle
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0.6) {
      return defaultEntscheidung('konversation', 'Confidence zu niedrig (' + parsed.confidence + ')', parsed.confidence || 0.0);
    }

    return {
      aktion: parsed.aktion,
      experte: parsed.experte || null,
      dok_typ: parsed.dok_typ || null,
      hinweis: parsed.hinweis || null,
      confidence: parsed.confidence
    };
  } catch (err) {
    return defaultEntscheidung('konversation', 'Fehler: ' + err.message, 0.0);
  }
}

module.exports = { routingEntscheidung };
