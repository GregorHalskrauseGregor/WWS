// Router — die EINE Entscheidungsstelle des Bots.
//
// Beantwortet pro Nachricht zwei Fragen in einem KI-Aufruf:
//   1. Zu WELCHEM Gesprächsfaden gehört sie?
//   2. WAS soll damit passieren — welcher Experte, oder normaler Chat?
//
// ROBUSTHEIT (aus einem echten Ausfall gelernt):
// Ein Reasoning-Modell kann eine LEERE Antwort liefern, wenn sein Nachdenken
// das Token-Budget aufbraucht. Passiert das, darf der Bot NICHT jedes Mal ein
// neues Thema anlegen — genau das hat vier Nachrichten in vier Themen zersplittert
// und den Kontext zerstört. Deshalb gilt hier:
//   - im Zweifel das JÜNGSTE Thema weiterführen, nie ein neues erzwingen
//   - ein neues Thema nur, wenn das Modell es ausdrücklich sagt (oder es keines gibt)
//   - bei leerer Antwort ein zweiter Versuch mit einem kurzen Prompt

const fs = require('fs');
const { SCHWELLEN } = require('../config');
const { extrahiere } = require('./json');
const experten = require('../experten');
const themen = require('../themen');
const vorgang = require('./vorgang');

function leiteThemaNamenAb(text) {
  const sauber = String(text || '').replace(/\s+/g, ' ').trim();
  if (!sauber) return 'Neues Thema';
  const woerter = sauber.split(' ').slice(0, 4).join(' ');
  return woerter.length > 50 ? woerter.slice(0, 47) + '...' : woerter;
}

// Modelle schreiben Experten-IDs gern mit deutschen Sonderzeichen zurueck
// (ß statt ss, Umlaute) oder mit Bindestrich. Die Absicht ist dann eindeutig,
// also vergleichen wir normalisiert, statt die Entscheidung wegzuwerfen.
function normId(wert) {
  return String(wert || '')
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]/g, '');
}

function findeExperteNachsichtig(liste, wert) {
  if (!wert) return null;
  const ziel = normId(wert);
  if (!ziel) return null;
  return liste.find((e) => normId(e.id) === ziel) || null;
}

function themenIndex(chatId) {
  try { return themen.ladeIndex(chatId); } catch { return []; }
}

// Der sichere Rückfall: das zuletzt aktive Thema (Index ist danach sortiert).
function juengstesThemaId(chatId) {
  const index = themenIndex(chatId);
  return index.length ? index[0].id : null;
}

function ergebnis({ themaId, themaName, aktion, experte, dokTyp, hinweis, confidence }) {
  return {
    thema: themaId
      ? { id: themaId, name: null, neu: false }
      : { id: null, name: themaName || 'Neues Thema', neu: true },
    aktion: aktion || 'konversation',
    experte: experte || null,
    dok_typ: dokTyp || null,
    hinweis: hinweis || null,
    confidence: typeof confidence === 'number' ? confidence : 0
  };
}

// ─────────────────────────────────────────────────────────────────── Prompts

function baueSystemPrompt({ themenBlock, expertenBlock, verlaufBlock }) {
  return `Du bist der Router eines Handwerker-Bots (SHK). Entscheide für die Nachricht ZWEI Dinge:
(1) zu welchem Gesprächsfaden sie gehört, (2) was damit passieren soll.

Antworte NUR mit einem JSON-Objekt. Kein Fließtext, keine Erklärung, kein Markdown.
Halte dich kurz beim Nachdenken — die Entscheidung ist meist offensichtlich.

THEMEN (jüngstes zuerst):
${themenBlock}

EXPERTEN (nur diese sind wählbar):
${expertenBlock}
${verlaufBlock}
AKTIONEN:
verarbeiten | konversation | nachfragen | vorlage_speichern | style_speichern | dokument_speichern

THEMENWAHL:
- Passt die Nachricht zu einem bestehenden Thema, gib dessen ID exakt zurück.
- Ein Thema mit OFFENEM VORGANG hat Vorrang, wenn die Nachricht dazu passt:
  Ergänzungen ("noch 3 Wandscheiben"), Korrekturen ("Position 2 auf 5"),
  Antworten auf eine Rückfrage ("16 Stück") und Bestätigungen ("passt", "fertig").
- Eine kurze Antwort ohne eigenes Thema ("16 Stück", "ja", "der zweite") gehört
  IMMER zum Faden, der zuletzt eine Frage gestellt hat — NIE in ein neues Thema.
- "neu" nur bei einem klaren Themenwechsel in einen anderen Sachbereich.

AKTIONSWAHL:
- Generische Wörter sind kein Auslöser: "brauche eine Anleitung" = Recherche,
  "höchste Leistung" = technische Eigenschaft, "schick dir gleich was" = konversation.
- Läuft im gewählten Thema ein Vorgang, ist die Aktion fast immer "verarbeiten"
  mit dem Experten dieses Vorgangs.
- Bei einer Datei: leeres Formular -> vorlage_speichern, Lieferschein mit Daten -> verarbeiten.
- Im Zweifel "konversation" mit niedriger confidence.

FORMAT (genau so, eine Zeile):
{"thema":"<themaId oder neu>","themaName":"<nur bei neu, 2-5 Wörter>","aktion":"<aktion>","experte":"<id oder null>","dok_typ":null,"hinweis":null,"confidence":0.0}`;
}

// Zweiter Versuch, falls die erste Antwort leer blieb: minimal, damit auch ein
// Reasoning-Modell mit knappem Budget zum Ergebnis kommt.
function baueKurzPrompt({ themenBlock, expertenBlock }) {
  return `Router. Antworte NUR mit einem JSON-Objekt, ohne Nachdenken davor.

Themen:
${themenBlock}

Experten: ${expertenBlock}

{"thema":"<themaId oder neu>","themaName":"","aktion":"verarbeiten|konversation|nachfragen","experte":"<id oder null>","confidence":0.0}`;
}

function baueThemenBlock(chatId) {
  const index = themenIndex(chatId);
  if (index.length === 0) return '(noch keine — dies eröffnet das erste: thema="neu")';
  const offen = new Map(vorgang.offeneVorgaenge(chatId).map((o) => [o.themaId, o]));
  return index.slice(0, 12).map((t) => {
    const o = offen.get(t.id);
    return `- ${t.id} | "${t.name}" | ${t.messageCount || 0} Nachrichten` +
      (o ? `\n    OFFENER VORGANG: ${o.experteId} (${o.status === 'bestaetigen' ? 'wartet auf Bestätigung' : 'sammelt noch Daten'})` : '');
  }).join('\n');
}

function baueVerlaufBlock(chatId) {
  let verlauf = [];
  try { verlauf = themen.letzteNachrichten(chatId, SCHWELLEN.ROUTER_VERLAUF_ANZAHL) || []; }
  catch { return ''; }
  if (verlauf.length === 0) return '';
  let text = verlauf.map((m) => `${m.rolle === 'user' ? 'User' : 'Bot'}: ${m.inhalt}`).join('\n');
  if (text.length > SCHWELLEN.ROUTER_VERLAUF_MAX_ZEICHEN) {
    text = '...' + text.slice(-SCHWELLEN.ROUTER_VERLAUF_MAX_ZEICHEN);
  }
  return `\nLETZTE NACHRICHTEN (jüngstes Thema):\n${text}\n`;
}

async function dateiVorschau(dokInfo) {
  if (!dokInfo || !dokInfo.pfad) return null;
  try {
    if (fs.statSync(dokInfo.pfad).size > SCHWELLEN.VORSCHAU_MAX_BYTES) return null;
    const buffer = fs.readFileSync(dokInfo.pfad);
    const istPdf = dokInfo.mimeType === 'application/pdf' ||
      (dokInfo.name && dokInfo.name.toLowerCase().endsWith('.pdf'));
    if (istPdf) {
      try {
        const daten = await require('pdf-parse')(buffer);
        return (daten.text || '').slice(0, SCHWELLEN.VORSCHAU_ZEICHEN);
      } catch { return null; }
    }
    if (dokInfo.mimeType && dokInfo.mimeType.startsWith('text/')) {
      return buffer.toString('utf-8').slice(0, SCHWELLEN.VORSCHAU_ZEICHEN);
    }
    return null;
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────────── Entscheidung

async function entscheide({ text, dokInfo, chatId, chat, protokoll }) {
  const rueckfall = juengstesThemaId(chatId);
  const melde = (t) => protokoll && protokoll('Router', t);

  if (typeof chat !== 'function') {
    return ergebnis({ themaId: rueckfall, themaName: leiteThemaNamenAb(text), hinweis: 'kein Chat-Dienst' });
  }
  if (!text && !dokInfo) {
    return ergebnis({ themaId: rueckfall, themaName: leiteThemaNamenAb(text), hinweis: 'leere Eingabe' });
  }

  const liste = experten.implementierteExperten();
  const themenBlock = baueThemenBlock(chatId);
  const expertenBlock = liste.length
    ? liste.map((e) => `- ${e.id} (${e.name}): ${e.zustaendigWenn}`).join('\n')
    : '(keine — nur "konversation" möglich)';

  const teile = [];
  if (text) teile.push('NACHRICHT:\n' + text);
  if (dokInfo) {
    const vorschau = await dateiVorschau(dokInfo);
    teile.push('DATEI:\n' +
      `- Name: ${dokInfo.name || '(unbekannt)'}\n` +
      `- Typ: ${dokInfo.mimeType || '(unbekannt)'}\n` +
      `- Größe: ${dokInfo.size != null ? dokInfo.size + ' Bytes' : '(unbekannt)'}` +
      (vorschau ? `\n- Inhalt (Anfang):\n${vorschau}` : ''));
  }
  const eingabe = teile.join('\n\n');

  // Erster Versuch, bei leerem Ergebnis ein zweiter mit kurzem Prompt.
  let parsed = null;
  try {
    parsed = extrahiere(await chat(baueSystemPrompt({ themenBlock, expertenBlock, verlaufBlock: baueVerlaufBlock(chatId) }), eingabe));
    if (!parsed) {
      melde('Erste Antwort ohne JSON — zweiter Versuch mit Kurz-Prompt.');
      parsed = extrahiere(await chat(baueKurzPrompt({ themenBlock, expertenBlock: liste.map((e) => e.id).join(', ') }), eingabe));
    }
  } catch (err) {
    return ergebnis({ themaId: rueckfall, themaName: leiteThemaNamenAb(text), hinweis: 'Router-Fehler: ' + err.message });
  }

  if (!parsed || typeof parsed !== 'object') {
    // WICHTIG: bestehenden Faden weiterführen, nicht zersplittern.
    return ergebnis({ themaId: rueckfall, themaName: leiteThemaNamenAb(text), hinweis: 'kein gültiges JSON, führe jüngstes Thema fort' });
  }

  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const bekannte = themenIndex(chatId).map((t) => t.id);
  const themaRoh = String(parsed.thema || '').trim();

  // Thema bestimmen — neu nur auf ausdrücklichen Wunsch oder wenn es keines gibt.
  let themaId;
  if (bekannte.includes(themaRoh)) themaId = themaRoh;
  else if (/^neu$/i.test(themaRoh) || bekannte.length === 0) themaId = null;
  else themaId = rueckfall; // unbekannte ID = Halluzination -> nicht zersplittern

  const erlaubt = ['verarbeiten', 'konversation', 'nachfragen',
    'vorlage_speichern', 'style_speichern', 'dokument_speichern'];

  // Nachsicht bei einem haeufigen Formfehler: Modelle schreiben die Experten-ID
  // gern direkt ins Feld aktion, statt aktion=verarbeiten zu setzen und die ID
  // ins Feld experte zu legen. Die Absicht ist dann eindeutig, also korrigieren
  // wir das, statt in die Konversation zurueckzufallen.
  let aktion = parsed.aktion;
  if (!erlaubt.includes(aktion) && findeExperteNachsichtig(liste, aktion)) {
    parsed.experte = aktion;
    aktion = 'verarbeiten';
  }
  parsed.aktion = aktion;

  if (!erlaubt.includes(parsed.aktion)) {
    return ergebnis({ themaId, themaName: parsed.themaName || leiteThemaNamenAb(text), hinweis: 'unbekannte Aktion: ' + parsed.aktion, confidence });
  }

  let experte = null;
  if (parsed.aktion === 'verarbeiten') {
    const treffer = findeExperteNachsichtig(liste, parsed.experte);
    experte = treffer ? treffer.id : null; // immer die echte ID zurueckgeben
    if (!experte) {
      return ergebnis({ themaId, themaName: parsed.themaName || leiteThemaNamenAb(text), hinweis: 'ungültiger Experte: ' + parsed.experte, confidence });
    }
  }

  if (confidence < SCHWELLEN.ROUTER_CONFIDENCE) {
    return ergebnis({ themaId, themaName: parsed.themaName || leiteThemaNamenAb(text), hinweis: `Confidence zu niedrig (${confidence})`, confidence });
  }

  return ergebnis({
    themaId,
    themaName: parsed.themaName || leiteThemaNamenAb(text),
    aktion: parsed.aktion,
    experte,
    dokTyp: parsed.dok_typ,
    hinweis: parsed.hinweis,
    confidence
  });
}

module.exports = { entscheide, leiteThemaNamenAb, juengstesThemaId };
