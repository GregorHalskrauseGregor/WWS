// Router — die EINE Entscheidungsstelle des Bots.
//
// Er beantwortet für jede eingehende Nachricht in EINEM KI-Aufruf zwei Fragen,
// die vorher getrennt (und damit widersprüchlich) beantwortet wurden:
//
//   1. Zu WELCHEM Gesprächsfaden gehört diese Nachricht?
//   2. WAS soll damit passieren — welcher Experte, oder normaler Chat?
//
// Vorher lief dafür erst kontext.klassifiziereThema() (kleines Modell, kannte
// keine laufenden Vorgänge) und danach ein separater Router (kannte den Faden
// nicht mehr). Ein "ändere Position 2 auf 5" konnte so im falschen Thema landen.
// Jetzt sieht der Router alle Themen MIT ihrem offenen Vorgang und entscheidet
// beides zusammen.

const fs = require('fs');
const { SCHWELLEN } = require('../config');
const experten = require('../experten');
const themen = require('../themen');
const vorgang = require('./vorgang');

function standard(aktion, hinweis, confidence, themaId) {
  return {
    thema: { id: themaId || null, name: null, neu: !themaId },
    aktion,
    experte: null,
    dok_typ: null,
    hinweis: hinweis || null,
    confidence: confidence != null ? confidence : 0.0
  };
}

// Fallback-Themenname, wenn die KI keinen liefert: die ersten Wörter.
function leiteThemaNamenAb(text) {
  const sauber = String(text || '').replace(/\s+/g, ' ').trim();
  if (!sauber) return 'Neues Thema';
  const woerter = sauber.split(' ').slice(0, 4).join(' ');
  return woerter.length > 50 ? woerter.slice(0, 47) + '...' : woerter;
}

function baueSystemPrompt({ themenBlock, expertenBlock, verlaufBlock }) {
  return `Du bist der Router eines Handwerker-Bots (SHK). Für jede Nachricht entscheidest du ZWEI Dinge auf einmal:
(1) zu welchem Gesprächsfaden (Thema) sie gehört, und (2) was mit ihr passieren soll.

════════ THEMEN DES NUTZERS (jüngstes zuerst) ════════
${themenBlock}

════════ VERFÜGBARE EXPERTEN ════════
Nur diese sind wählbar. Nicht gelistete Experten existieren für dich nicht.
${expertenBlock}
${verlaufBlock}
════════ AKTIONEN ════════
- "verarbeiten"        Ein Experte soll die Nachricht bearbeiten. Setze "experte".
- "konversation"       Normaler Chat, kein Experte nötig.
- "nachfragen"         Anfrage unklar. Formuliere die Rückfrage in "hinweis".
- "vorlage_speichern"  Angehängte Datei ist ein leeres Formular / eine Vorlage.
- "style_speichern"    Angehängte Datei ist eine Formatvorlage / ein Style-Sheet.
- "dokument_speichern" Datei soll nur abgelegt werden, keine Verarbeitung.

════════ REGELN ZUR THEMENWAHL ════════
- Gehört die Nachricht inhaltlich zu einem bestehenden Thema, gib dessen ID zurück.
- Ein Thema mit OFFENEM VORGANG ist stark bevorzugt, wenn die Nachricht dazu passt:
  Ergänzungen ("noch 3 Wandscheiben"), Korrekturen ("Position 2 auf 5", "Bezeichnung
  war Heizung"), Bestätigungen ("passt", "fertig", "ok", "mach das PDF") und
  Rückfrage-Antworten gehören IMMER zu dem Vorgang, der darauf wartet.
- Laufen MEHRERE Vorgänge, entscheide am Inhalt: eine Projektnummer, ein Kundenname
  oder ein Material, das in genau einem Vorgang vorkommt, ordnet die Nachricht dorthin zu.
  Ist es nicht zu entscheiden, wähle "nachfragen" und frage, welcher Vorgang gemeint ist.
- Ein klarer Themenwechsel (anderer Sachbereich) ist ein NEUES Thema: gib
  "thema":"neu" und einen kurzen deutschen "themaName" (2-5 Wörter).
- Kurze Höflichkeiten ("danke", "ok") gehören zum jüngsten Thema, nicht in ein neues.

════════ REGELN ZUR AKTIONSWAHL ════════
- Generische Wörter sind KEIN automatischer Auslöser. Interpretiere im Kontext:
    "ich brauche eine Anleitung"   → Recherche, NICHT Bestellung
    "höchste Leistung der Pumpe"   → technische Eigenschaft, NICHT Abrechnung
    "ich schick dir gleich was"    → Ankündigung, also "konversation"
- "Außerbetriebnahme", "Reparatur", "Wartung" sind keine Aufmaße.
- Bei einer Datei: Dateiname UND Inhalts-Vorschau beachten.
    leeres Formular mit Feldern, keine Daten  → vorlage_speichern
    Lieferschein/Rechnung mit echten Daten    → verarbeiten (passender Experte)
- Im Zweifel: "konversation" mit niedriger confidence. Lieber nichts als das Falsche.
- confidence < ${SCHWELLEN.ROUTER_CONFIDENCE}: der Bot führt keine Aktion aus, sondern antwortet normal.

════════ ANTWORTFORMAT ════════
Antworte AUSSCHLIESSLICH mit genau einem JSON-Objekt, ohne Markdown, ohne Erklärung:

{
  "thema": "<themaId>" oder "neu",
  "themaName": "<nur wenn thema=neu, 2-5 Wörter deutsch>",
  "aktion": "verarbeiten|konversation|nachfragen|vorlage_speichern|style_speichern|dokument_speichern",
  "experte": "<id>" oder null,
  "dok_typ": "daten|vorlage|anhang" oder null,
  "hinweis": "<kurzer Text oder null>",
  "confidence": 0.0-1.0
}`;
}

function baueThemenBlock(chatId) {
  let index = [];
  try { index = themen.ladeIndex(chatId); } catch { index = []; }
  if (index.length === 0) {
    return '(noch keine Themen — die erste Nachricht eröffnet eines: thema="neu")';
  }
  const offene = vorgang.offeneVorgaenge(chatId);
  const offenNach = new Map(offene.map((o) => [o.themaId, o]));

  return index.slice(0, 15).map((t) => {
    const o = offenNach.get(t.id);
    const vorgangsText = o
      ? `  ⚠ OFFENER VORGANG: ${o.experteId} (${o.status === 'bestaetigen' ? 'wartet auf Bestätigung' : 'sammelt noch Daten'})`
      : '';
    return `- ${t.id} | "${t.name}" | ${t.messageCount || 0} Nachrichten | zuletzt: ${t.lastActivity}${vorgangsText ? '\n' + vorgangsText : ''}`;
  }).join('\n');
}

function baueExpertenBlock(liste) {
  return liste.map((e) => `- ${e.id} (${e.emoji || ''} ${e.name}): ${e.zustaendigWenn}`).join('\n');
}

async function baueVerlaufBlock(chatId) {
  let verlauf = [];
  try {
    verlauf = themen.letzteNachrichten(chatId, SCHWELLEN.ROUTER_VERLAUF_ANZAHL) || [];
  } catch { return ''; }
  if (verlauf.length === 0) return '';
  let text = verlauf
    .map((m) => `${m.rolle === 'user' ? 'User' : 'Bot'}: ${m.inhalt}`)
    .join('\n');
  if (text.length > SCHWELLEN.ROUTER_VERLAUF_MAX_ZEICHEN) {
    text = '...' + text.slice(-SCHWELLEN.ROUTER_VERLAUF_MAX_ZEICHEN);
  }
  return `\n════════ LETZTE NACHRICHTEN (jüngstes Thema) ════════\n${text}\n`;
}

// Erste Zeichen einer Datei als Vorschau — hilft dem Router zu unterscheiden,
// ob ein PDF eine leere Vorlage oder ein ausgefüllter Lieferschein ist.
async function dateiVorschau(dokInfo) {
  if (!dokInfo || !dokInfo.pfad) return null;
  try {
    const stat = fs.statSync(dokInfo.pfad);
    if (stat.size > SCHWELLEN.VORSCHAU_MAX_BYTES) return null;
    const buffer = fs.readFileSync(dokInfo.pfad);
    const istPdf = dokInfo.mimeType === 'application/pdf' ||
      (dokInfo.name && dokInfo.name.toLowerCase().endsWith('.pdf'));
    if (istPdf) {
      try {
        const pdfParse = require('pdf-parse');
        const daten = await pdfParse(buffer);
        return (daten.text || '').slice(0, SCHWELLEN.VORSCHAU_ZEICHEN);
      } catch { return null; }
    }
    if (dokInfo.mimeType && dokInfo.mimeType.startsWith('text/')) {
      return buffer.toString('utf-8').slice(0, SCHWELLEN.VORSCHAU_ZEICHEN);
    }
    return null;
  } catch { return null; }
}

// Robustes JSON-Bergen: Codeblock, dann roher Block, jeweils balanciert.
function parseJson(roh) {
  if (!roh || typeof roh !== 'string') return null;
  const md = roh.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const kandidaten = [];
  if (md) kandidaten.push(md[1]);
  const alle = roh.match(/\{[\s\S]*\}/g) || [];
  kandidaten.push(...alle.reverse());
  for (const k of kandidaten) {
    try { return JSON.parse(k); } catch { /* nächsten */ }
  }
  return null;
}

// Hauptfunktion. chat = async (systemPrompt, userText) => string
async function entscheide({ text, dokInfo, chatId, chat }) {
  if (typeof chat !== 'function') return standard('konversation', 'kein Chat-Dienst', 0.0);
  if (!text && !dokInfo) return standard('konversation', 'leere Eingabe', 0.0);

  const liste = experten.implementierteExperten();
  const themenBlock = baueThemenBlock(chatId);
  const expertenBlock = liste.length
    ? baueExpertenBlock(liste)
    : '(keine Experten verfügbar — nur "konversation" möglich)';
  const verlaufBlock = await baueVerlaufBlock(chatId);

  const teile = [];
  if (text) teile.push('USER-NACHRICHT:\n' + text);
  if (dokInfo) {
    const vorschau = await dateiVorschau(dokInfo);
    teile.push(
      'ANGEHÄNGTE DATEI:\n' +
      `- Dateiname: ${dokInfo.name || '(unbekannt)'}\n` +
      `- MIME-Type: ${dokInfo.mimeType || '(unbekannt)'}\n` +
      `- Größe: ${dokInfo.size != null ? dokInfo.size + ' Bytes' : '(unbekannt)'}` +
      (vorschau ? `\n- Inhalt (Anfang):\n${vorschau}` : '')
    );
  }

  const systemPrompt = baueSystemPrompt({ themenBlock, expertenBlock, verlaufBlock });

  let parsed;
  try {
    parsed = parseJson(await chat(systemPrompt, teile.join('\n\n')));
  } catch (err) {
    return standard('konversation', 'Router-Fehler: ' + err.message, 0.0);
  }
  if (!parsed || typeof parsed !== 'object') {
    return standard('konversation', 'Router lieferte kein gültiges JSON', 0.0);
  }

  // ---- Validierung: die KI schlägt vor, der Code entscheidet ----
  let bekannteThemen = [];
  try { bekannteThemen = themen.ladeIndex(chatId).map((t) => t.id); } catch { /* leer */ }

  const themaRoh = String(parsed.thema || 'neu');
  const themaBekannt = bekannteThemen.includes(themaRoh);
  const thema = themaBekannt
    ? { id: themaRoh, name: null, neu: false }
    : { id: null, name: (parsed.themaName || leiteThemaNamenAb(text)).trim(), neu: true };

  const erlaubteAktionen = ['verarbeiten', 'konversation', 'nachfragen',
    'vorlage_speichern', 'style_speichern', 'dokument_speichern'];
  if (!erlaubteAktionen.includes(parsed.aktion)) {
    return { ...standard('konversation', 'unbekannte Aktion: ' + parsed.aktion, 0.0), thema };
  }

  let experte = null;
  if (parsed.aktion === 'verarbeiten') {
    experte = liste.find((e) => e.id === parsed.experte) ? parsed.experte : null;
    if (!experte) {
      // Stub oder Halluzination — nicht ausführen, aber Thema behalten.
      return { ...standard('konversation', 'ungültiger Experte: ' + parsed.experte, 0.0), thema };
    }
  }

  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.0;
  if (confidence < SCHWELLEN.ROUTER_CONFIDENCE) {
    return { ...standard('konversation', `Confidence zu niedrig (${confidence})`, confidence), thema };
  }

  return {
    thema,
    aktion: parsed.aktion,
    experte,
    dok_typ: parsed.dok_typ || null,
    hinweis: parsed.hinweis || null,
    confidence
  };
}

module.exports = { entscheide, leiteThemaNamenAb, _parseJson: parseJson };
