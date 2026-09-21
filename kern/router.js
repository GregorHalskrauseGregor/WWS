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

// Unter diesem Anteil gefuellter Formularfelder gilt ein PDF als leere Vorlage.
const ANTEIL_VORLAGE = 0.10;
const { SCHWELLEN } = require('../config');
const { extrahiere } = require('./json');
const experten = require('../experten');
const wissensbasis = require('../lib/wissen');
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

function ergebnis({ themaId, themaName, aktion, experte, dokTyp, hinweis, confidence, wissen, weitereBefehle }) {
  return {
    thema: themaId
      ? { id: themaId, name: null, neu: false }
      : { id: null, name: themaName || 'Neues Thema', neu: true },
    aktion: aktion || 'konversation',
    experte: experte || null,
    // Welche Wissenskarten mit in den Experten-Prompt sollen. Leer = keine.
    wissen: Array.isArray(wissen) ? wissen : [],
    dok_typ: dokTyp || null,
    hinweis: hinweis || null,
    confidence: typeof confidence === 'number' ? confidence : 0,
    // Multi-Befehl-Modus: Array von Folge-Entscheidungen, jeder mit dem gleichen
    // Schema. Leer/nicht vorhanden = Single-Command (alter Pfad).
    weitere_befehle: Array.isArray(weitereBefehle) ? weitereBefehle : []
  };
}

// ─────────────────────────────────────────────────────────────────── Prompts

function baueSystemPrompt({ themenBlock, expertenBlock, verlaufBlock, hatDatei, wissensBlock }) {
  // Ohne angehaengte Datei duerfen die Datei-Aktionen gar nicht erst zur Wahl
  // stehen. Sonst antwortet der Bot auf eine reine Sprachnachricht mit
  // "Schick mir die Datei dazu" — und der gesprochene Inhalt ist verloren.
  const aktionen = hatDatei
    ? 'verarbeiten | konversation | nachfragen | vorlage_speichern | style_speichern | dokument_speichern'
    : 'verarbeiten | konversation | nachfragen';
  const dateiRegeln = hatDatei
    ? `\n- Zur Datei: ein LEERES Formular (nur Feldnamen, keine Werte) -> vorlage_speichern.
  Ein Lieferschein oder eine Tabelle MIT echten Daten -> verarbeiten.
  Beachte den Hinweis zur Datei unten, falls vorhanden.`
    : '\n- Es ist KEINE Datei angehaengt. Die Datei-Aktionen stehen nicht zur Wahl.';

  return `Du bist der Router eines Handwerker-Bots (SHK). Du entscheidest für jede eingehende Nachricht — auch wenn sie unvollständig ist, durcheinander ankommt oder eine Folge-Nachricht zu einer offenen Frage ist — WAS der Bot damit tun soll.

Du arbeitest strikt KI-basiert: keine Schluesselwoerter, keine Heuristik, keine Regeln. Du liest die Bedeutung der Nachricht im Kontext des bisherigen Fadens und entscheidest. Wenn du dir unsicher bist, nimm "nachfragen" mit einem konkreten Hinweis — der Nutzer kann dann in der naechsten Nachricht korrigieren oder erlaeutern. Es gibt IMMER eine Loesung, nie einen toten Pfad.

Antworte NUR mit einem JSON-Objekt. Kein Fliesstext, keine Erklaerung, kein Markdown.

THEMEN (jüngstes zuerst):
${themenBlock}

EXPERTEN (jede:r ist ein klar abgegrenzter Verantwortungsbereich, lies die Beschreibung):
${expertenBlock}

WISSENSKARTEN (Fachwissen, das du dem Experten mitgeben kannst — waehle nur, was fuer DIESE Nachricht gebraucht wird):
${wissensBlock}
${verlaufBlock}
AKTIONEN:
${aktionen}

ENTSCHEIDUNGSREGELN:

(1) Themenwahl:
- Passt die Nachricht zu einem bestehenden Thema, nimm dessen ID.
- Hat das juengste Thema einen OFFENEN VORGANG und die Nachricht erweitert, korrigiert oder beantwortet ihn, gehoert sie IMMER zu diesem Thema. Auch wenn die Nachricht nur ein paar Worte hat ("ja", "16", "geaendert", "Position 2 raus").
- "neu" nur bei einem klaren Themenwechsel in einen anderen Sachbereich. Im Zweifel lieber das juengste Thema weiterfuehren als ein neues aufmachen.

(2) Aktionswahl:
- Läuft im gewählten Thema ein Vorgang, ist die Aktion fast immer "verarbeiten" mit dem Experten dieses Vorgangs. Auch wenn die Nachricht unvollständig ist ("DN20", "gebraucht", "noch 3 mehr") — der Experte sammelt weiter.
- Läuft KEIN Vorgang und die Nachricht enthaelt einen klaren Wunsch, nimm den passenden Experten.
- Hat der Bot in der letzten Nachricht eine RÜCKFRAGE gestellt und die neue Nachricht beantwortet sie, dann ist das die Fortsetzung derselben Sache: gleiches Thema, "verarbeiten", und derselbe Experte, um den es in der Rückfrage ging. Niemals ein neuer Vorgang.
- "nachfragen" NUR, wenn du wirklich nicht weißt, zu welchem Sachbereich die Nachricht gehört. Sobald du den Experten benennen kannst, nimm "verarbeiten" — der Experte trägt ein, was schon dasteht, und fragt selbst nach dem Rest. Eine Rückfrage von dir wirft alles weg, was der Nutzer bis dahin geschrieben hat.
- "konversation" nur fuer Smalltalk und Rueckmeldungen, die mit keinem Sachbereich zu tun haben.
${dateiRegeln}

(3) Wissenskarten:
- Waehle die Karten, deren "Laden wenn" auf diese Nachricht passt — als Liste von IDs im Feld "wissen".
- Sparsam sein: jede Karte kostet Tokens. Zwei bis drei sind normal, alle sechs fast nie noetig.
- Bei "konversation" und "nachfragen" in aller Regel eine leere Liste.
- Im Zweifel lieber eine Karte zu viel als eine zu wenig — eine fehlende Karte laesst den
  Experten raten, und geratenes Fachwissen landet in der Lagerdatei.

(4) Robuster Umgang mit kaputten Eingaben:
- Auch unvollstaendige Saetze ("DN20", "1m", "gebraucht"), einzelne Worte ("passt") oder offensichtlich verlegte Worte ("3 Pressfittings Edelstahl 28mm neu" als dritte Zeile nach Einlager-Anweisungen) gehoeren in den richtigen Faden — lies den Verlauf, nicht die Heuristik.
- Eine bewusste Aenderung des Themas ("ganz anderes Thema", "nebenbei", "zurueck zum Aufmass") startet ein neues Thema. Sonst nicht.
- Du darfst auch bei subjektiv "schwierigen" Eingaben mutig entscheiden — der Nutzer kann jederzeit korrigieren. Lieber eine Entscheidung treffen und Hinweise geben als gar nichts entscheiden.

(5) Multi-Befehl (weitere_befehle):
- Wenn die Nachricht MEHRERE UNABHAENGIGE Aufgaben an verschiedene Experten enthaelt
  (z. B. "bestell 5 Kugelhaehne, mach ein Aufmass fuer Badezimmer, such Anleitung PE-Rohr"),
  pack die Folge-Aufgaben in "weitere_befehle" als Array. Jeder Eintrag hat das
  GLEICHE Schema wie der Hauptbefehl (thema/themaName/aktion/experte/wissen/dok_typ/hinweis/confidence).
- NICHT als Multi-Befehl werten: ein Auftrag mit mehreren Positionen
  ("bestell diese 3 Artikel" = 1 Bestellbefehl, NICHT 3).
- NICHT als Multi-Befehl werten: Folge-Aktionen am selben Experten
  ("leg den Artikel an und aender die Beschreibung" = 1 Befehl, NICHT 2).
- NICHT als Multi-Befehl werten: ein Fach-Befehl + ein Smalltalk-Anteil.
- Im Zweifel: 1 Befehl statt falsch aufgeteilt.

FORMAT (genau so, eine Zeile, weitere_befehle nur wenn vorhanden):
{"thema":"<themaId oder neu>","themaName":"<nur bei neu, 2-5 Wörter>","aktion":"<aktion>","experte":"<id oder null>","wissen":["<kartenId>"],"dok_typ":null,"hinweis":null,"confidence":0.0,"weitere_befehle":[]}`;
}

// Zweiter Versuch, falls die erste Antwort leer blieb: minimal, damit auch ein
// Reasoning-Modell mit knappem Budget zum Ergebnis kommt.
function baueKurzPrompt({ themenBlock, expertenBlock }) {
  return `Router eines SHK-Bots. Antworte NUR mit einem JSON-Objekt, ohne Nachdenken davor.
Strikt KI-basiert entscheiden, keine Schluesselwoerter. Im Zweifel "nachfragen" waehlen.

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
  // Von hinten auffuellen: die juengsten Nachrichten muessen VOLLSTAENDIG
  // dastehen. Frueher wurde der fertige Block am Stueck abgeschnitten — dabei
  // fiel regelmaessig der Anfang weg, also gerade die Nachricht, auf die sich
  // die aktuelle bezieht. Lieber eine alte Nachricht ganz weglassen als die
  // neueste zerstueckeln.
  const zeilen = [];
  let budget = SCHWELLEN.ROUTER_VERLAUF_MAX_ZEICHEN;
  let gekuerzt = false;
  for (let i = verlauf.length - 1; i >= 0; i--) {
    const m = verlauf[i];
    const zeile = `${m.rolle === 'user' ? 'User' : 'Bot'}: ${String(m.inhalt || '')}`;
    if (zeile.length > budget) { gekuerzt = true; break; }
    budget -= zeile.length;
    zeilen.unshift(zeile);
  }
  if (!zeilen.length) return '';
  const text = (gekuerzt ? '(aeltere Nachrichten weggelassen)\n' : '') + zeilen.join('\n');
  return `\nLETZTE NACHRICHTEN (jüngstes Thema):\n${text}\n`;
}

// Vorschau + ein deterministisches Urteil, ob die Datei eine LEERE VORLAGE ist.
// Das muss die KI nicht raten: ein PDF mit vielen Formularfeldern und kaum
// Textinhalt ist ein Blankoformular, kein ausgefuellter Lieferschein.
async function dateiVorschau(dokInfo) {
  const leer = { text: null, hinweis: null, formular: null };
  if (!dokInfo || !dokInfo.pfad) return leer;
  try {
    const groesse = fs.statSync(dokInfo.pfad).size;
    const istPdf = dokInfo.mimeType === 'application/pdf' ||
      (dokInfo.name && dokInfo.name.toLowerCase().endsWith('.pdf'));

    if (istPdf) {
      if (groesse > SCHWELLEN.FORMULAR_MAX_BYTES) return leer;
      // Formularfelder zuerst: zuverlaessigster Befund, ohne OCR und ohne
      // native Abhaengigkeiten — und unabhaengig von der Textvorschau-Grenze.
      let felder = null;
      try { felder = await require('../lib/pdf_filler').leseFeldWerte(dokInfo.pfad); }
      catch { /* kein AcroForm-PDF */ }

      // Textextraktion nur, wenn die Felder nichts hergeben. pdf-parse braucht
      // native Canvas-Bindings und faellt in manchen Umgebungen ganz aus.
      let text = '';
      const brauchtText = !felder || felder.ausgefuellt.length === 0;
      if (brauchtText && groesse <= SCHWELLEN.VORSCHAU_MAX_BYTES) {
        try { text = (await require('pdf-parse')(fs.readFileSync(dokInfo.pfad))).text || ''; }
        catch { /* nicht ueberall verfuegbar */ }
      }

      let hinweis = null;
      let vorschau = text.slice(0, SCHWELLEN.VORSCHAU_ZEICHEN) || null;

      if (felder && felder.gesamt > 5) {
        const anzahl = felder.ausgefuellt.length;
        // Verhaeltnis statt Null-Pruefung: in einer Vorlage stehen oft ein paar
        // Reste (Seitenzahl, ein Testeintrag). Ein echtes Aufmass fuellt dagegen
        // Dutzende Positionsfelder.
        felder.istVorlage = anzahl / felder.gesamt < ANTEIL_VORLAGE;
        if (felder.istVorlage) {
          hinweis = `${felder.gesamt} ausfuellbare Formularfelder, davon nur ${anzahl} ` +
            `mit Inhalt. Ein ausgefuellter Beleg haette Dutzende gefuellte Felder — ` +
            `das hier ist ein Blankoformular, also eine VORLAGE.`;
        } else {
          hinweis = `${felder.gesamt} Formularfelder, davon ${anzahl} ausgefuellt — ` +
            `also ein ausgefuelltes Formular mit echten Daten.`;
          vorschau = felder.ausgefuellt.slice(0, 25)
            .map((f) => `${f.name}: ${f.wert}`).join('\n').slice(0, SCHWELLEN.VORSCHAU_ZEICHEN);
        }
      }
      return { text: vorschau, hinweis, formular: felder };
    }

    if (dokInfo.mimeType && dokInfo.mimeType.startsWith('text/') &&
        groesse <= SCHWELLEN.VORSCHAU_MAX_BYTES) {
      return {
        text: fs.readFileSync(dokInfo.pfad, 'utf-8').slice(0, SCHWELLEN.VORSCHAU_ZEICHEN),
        hinweis: null, formular: null
      };
    }
    return leer;
  } catch { return leer; }
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

  const hatDatei = !!dokInfo;
  const liste = experten.implementierteExperten();
  const themenBlock = baueThemenBlock(chatId);
  const expertenBlock = liste.length
    ? liste.map((e) => `- ${e.id} (${e.name}): ${e.zustaendigWenn}`).join('\n')
    : '(keine — nur "konversation" möglich)';

  const teile = [];
  if (text) teile.push('NACHRICHT:\n' + text);
  let befund = null;
  if (dokInfo) {
    const analyse = await dateiVorschau(dokInfo);
    befund = analyse.formular;
    const { text: vorschau, hinweis: dateiHinweis } = analyse;
    teile.push('DATEI:\n' +
      `- Name: ${dokInfo.name || '(unbekannt)'}\n` +
      `- Typ: ${dokInfo.mimeType || '(unbekannt)'}\n` +
      `- Größe: ${dokInfo.size != null ? dokInfo.size + ' Bytes' : '(unbekannt)'}` +
      (dateiHinweis ? `\n- BEFUND: ${dateiHinweis}` : '') +
      (vorschau ? `\n- Inhalt (Anfang):\n${vorschau}` : ''));
  }
  const eingabe = teile.join('\n\n');

  // Erster Versuch, bei leerem Ergebnis ein zweiter mit kurzem Prompt.
  let parsed = null;
  try {
    parsed = extrahiere(await chat(
      baueSystemPrompt({ themenBlock, expertenBlock, verlaufBlock: baueVerlaufBlock(chatId), hatDatei, wissensBlock: wissensbasis.katalog() }), eingabe));
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

  // Kartenwahl saeubern. Ein Modell darf sich hier irren, ohne dass es weh tut:
  // erfundene IDs fliegen raus, und mehr als vier Karten sind nie noetig — das
  // waere fast die ganze Wissensbasis und damit genau der Tokenverbrauch, den
  // die Auswahl vermeiden soll.
  const bekannteKarten = wissensbasis.karten().map((k) => k.id);
  const gewaehlteKarten = (Array.isArray(parsed.wissen) ? parsed.wissen : [])
    .map((w) => String(w || '').trim().toLowerCase())
    .filter((w) => bekannteKarten.includes(w))
    .slice(0, 4);

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

  // Sicherheitsnetz: eine Datei-Aktion ohne Datei ist immer ein Modellfehler.
  // Statt den Nutzer nach einer Datei zu fragen, die er nie erwaehnt hat,
  // behandeln wir die Nachricht normal weiter.
  const dateiAktionen = ['vorlage_speichern', 'style_speichern', 'dokument_speichern'];

  // Hier gibt es eine richtige Antwort, also entscheidet der Code: ein
  // Blankoformular ohne begleitende Angaben ist eine Vorlage. Das Modell hat in
  // der Praxis stattdessen den Aufmass-Experten gewaehlt und damit ein leeres
  // Aufmass gestartet. Schreibt der Nutzer etwas Substanzielles dazu, bleibt
  // die Entscheidung beim Modell.
  const kaumText = String(text || '').trim().length < 25;
  if (hatDatei && befund && befund.istVorlage && kaumText && parsed.aktion !== 'style_speichern') {
    if (parsed.aktion !== 'vorlage_speichern') {
      melde(`Blankoformular erkannt (${befund.ausgefuellt.length}/${befund.gesamt} Felder gefuellt) ` +
        `-> als Vorlage abgelegt statt "${parsed.aktion}"`);
    }
    return ergebnis({
      themaId, themaName: parsed.themaName || leiteThemaNamenAb(text),
      aktion: 'vorlage_speichern', dokTyp: 'vorlage',
      hinweis: parsed.hinweis, confidence: Math.max(confidence, 0.9), wissen: []
    });
  }

  if (!hatDatei && dateiAktionen.includes(parsed.aktion)) {
    const treffer = findeExperteNachsichtig(liste, parsed.experte);
    parsed.aktion = treffer ? 'verarbeiten' : 'konversation';
    melde(`Datei-Aktion ohne Datei verworfen -> ${parsed.aktion}`);
  }

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

  // Keine harte Confidence-Schwelle mehr. Wenn die KI eine Entscheidung
  // trifft, wird sie verwendet — der Nutzer kann sie in der Folgenachricht
  // korrigieren. Lieber eine fragwürdige Entscheidung treffen als den Nutzer
  // hängen lassen.
  if (typeof confidence !== 'number') {
    melde(`Router-Confidence fehlt, Entscheidung wird trotzdem verwendet: ${parsed.aktion}/${experte || '-'}`);
  }

  return ergebnis({
    themaId,
    themaName: parsed.themaName || leiteThemaNamenAb(text),
    aktion: parsed.aktion,
    experte,
    dokTyp: parsed.dok_typ,
    hinweis: parsed.hinweis,
    confidence,
    wissen: gewaehlteKarten,
    weitereBefehle: parseWeitereBefehle(parsed.weitere_befehle, liste, text, melde)
  });
}

// Multi-Befehle normalisieren: Schema-Validierung, Karten filtern, ungültige
// verwerfen (ein einziger schlechter Folge-Befehl darf den Workflow nicht kippen).
function parseWeitereBefehle(raw, expertenListe, originalText, melde) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const raus = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    let aktion = String(b.aktion || '').trim();
    if (!erlaubtAktionen().includes(aktion)) {
      // Modell hat die ID in aktion statt experte gesteckt — gleiche Korrektur
      // wie beim Hauptbefehl.
      if (findeExperteNachsichtig(expertenListe, aktion)) {
        b.experte = aktion;
        aktion = 'verarbeiten';
      } else {
        continue;
      }
    }
    if (aktion === 'verarbeiten' && !findeExperteNachsichtig(expertenListe, b.experte)) {
      melde(`Folge-Befehl verworfen — ungültiger Experte: ${b.experte}`);
      continue;
    }
    const exp = aktion === 'verarbeiten'
      ? findeExperteNachsichtig(expertenListe, b.experte)
      : null;
    const karten = (Array.isArray(b.wissen) ? b.wissen : [])
      .map((w) => String(w || '').trim().toLowerCase())
      .filter((w) => wissensbasis.karten().some((k) => k.id === w))
      .slice(0, 4);
    raus.push({
      themaId: null,  // wird vom Orchestrator erstellt
      themaName: b.themaName || leiteThemaNamenAb(originalText),
      aktion,
      experte: exp ? exp.id : null,
      dokTyp: b.dok_typ || null,
      hinweis: b.hinweis || null,
      confidence: typeof b.confidence === 'number' ? b.confidence : 0,
      wissen: karten
    });
  }
  return raus;
}

function erlaubtAktionen() {
  return ['verarbeiten', 'konversation', 'nachfragen',
    'vorlage_speichern', 'style_speichern', 'dokument_speichern'];
}

module.exports = { entscheide, leiteThemaNamenAb, juengstesThemaId, dateiVorschau,
  // nur fuer Tests: der Verlaufsblock ist die Stelle, an der dem Router frueher
  // der Anfang eines Gespraechs abhanden kam.
  _intern: { baueVerlaufBlock, baueThemenBlock } };
