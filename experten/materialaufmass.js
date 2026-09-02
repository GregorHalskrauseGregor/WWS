// MATERIALAUFMASS-EXPERTE (nicht-iterativ)
//
// Designentscheidung: keine Schritt-für-Schritt-Führung. Der User schickt
// einfach eine Nachricht mit allem, was er hat (Projektnummer, Bezeichnung,
// Positionen). Die KI extrahiert ALLES in EINER API-Anfrage zu JSON.
// Dann wird geprüft, ob was fehlt — wenn ja, EIN Hinweis. Wenn nein, sofort
// PDF generieren und senden.
//
// Anpassungen: der User kann jederzeit "ändere Position 2 auf 5" oder ähnliches
// schicken. Wir mergen die Änderung in die bestehende Session.
//
// Persistente Session: data/users/<chatId>/aufnahme_session.json
// - überlebt Bot-Restart
// - ein Aufmaß pro User gleichzeitig (reicht für die meisten Use-Cases)

const fs = require('fs');
const path = require('path');

const libPdf = require('../lib/pdf');
const libPdfReader = require('../lib/pdf_reader');
const libPdfFiller = require('../lib/pdf_filler');
const libUnterschrift = require('../lib/unterschrift');

const VORLAGE_ORDNER = path.join(__dirname, '..', 'data', 'aufnahme_vorlage');
const STYLE_ORDNER = path.join(__dirname, '..', 'data', 'style_sheet');
const SESSION_ORDNER = (chatId) => path.join(__dirname, '..', 'data', 'users', String(chatId));

function sessionPfad(chatId) {
  return path.join(SESSION_ORDNER(chatId), 'aufnahme_session.json');
}

function ladeSession(chatId) {
  const p = sessionPfad(chatId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function speichereSession(chatId, session) {
  fs.mkdirSync(SESSION_ORDNER(chatId), { recursive: true });
  fs.writeFileSync(sessionPfad(chatId), JSON.stringify(session, null, 2), 'utf-8');
}

function loescheSession(chatId) {
  const p = sessionPfad(chatId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function findeVorlage() {
  if (!fs.existsSync(VORLAGE_ORDNER)) return null;
  const dateien = fs.readdirSync(VORLAGE_ORDNER)
    .filter((d) => d.toLowerCase().endsWith('.pdf'))
    .sort();
  return dateien.length > 0 ? path.join(VORLAGE_ORDNER, dateien[0]) : null;
}

function findeStyleSheet() {
  if (!fs.existsSync(STYLE_ORDNER)) return null;
  const dateien = fs.readdirSync(STYLE_ORDNER)
    .filter((d) => /\.(pdf|txt|md)$/i.test(d))
    .sort();
  return dateien.length > 0 ? path.join(STYLE_ORDNER, dateien[0]) : null;
}

function baueSystemPromptFuerExtraktion(existingSession) {
  const ctx = existingSession
    ? `\n\nBISHERIGE SESSION (kann vom Nutzer angepasst werden):\n${JSON.stringify(existingSession, null, 2)}\n\nWenn der Nutzer eine Änderung schickt (z.B. "ändere Position 2 auf 5", "Position 3 raus", "Bezeichnung war Heizung, nicht Sanitär"), ÜBERTRAGE die Änderung in die Session und gib das AKTUALISIERTE JSON zurück. Wenn der Nutzer komplett neue Daten schickt, ersetzen sie die Session.`
    : '\n\nEs gibt noch keine bestehende Session — du startest eine neue.';

  return `Du bist der Materialaufmaß-Extraktor. Deine EINZIGE Aufgabe: aus der Nutzernachricht strukturierte Daten extrahieren und als JSON zurückgeben.

⚠️ WICHTIG — ANTWORT-FORMAT ⚠️
Antworte AUSSCHLIESSLICH mit genau einem JSON-Objekt. KEIN zusätzlicher Text davor oder danach, KEINE Markdown-Formatierung, KEINE Tabellen, KEINE Erklärungen, KEIN "Hier ist das JSON:".

Nur das rohe JSON-Objekt in genau dieser Form:

{
  "projekt": {
    "nummer": "PRJ-2026-001",
    "bezeichnung": "Badsanierung Müller"
  },
  "positionen": [
    { "name": "Kupferrohr 22mm", "menge": 12, "einheit": "m", "artikelnummer": null },
    { "name": "Wandscheibe DN20", "menge": 3, "einheit": "Stk.", "artikelnummer": "WS-12345" }
  ],
  "vollstaendig": true,
  "fehlt": []
}

Falls die Nutzernachricht KEINE Aufmaß-Daten enthält (User schreibt etwas Beliebiges wie "passt", "fertig", "stop"), gib dieses minimale Gerüst zurück:

{"projekt": {"nummer": null, "bezeichnung": null}, "positionen": [], "vollstaendig": false, "fehlt": ["Projektnummer", "Bezeichnung", "mindestens 1 Position"]}

Extraktionsregeln:
- Projektnummer: erstes erkennbares Token mit Format wie "PRJ-XXXX", "PRJ-2026-001", "Projekt 123", "26-0111" oder "2026/123". Wenn der Nutzer "26-0111 Heizraumumbau" schreibt, ist "26-0111" die Nummer.
- Bezeichnung: alles zwischen Projektnummer und erster Position, oder die ganze Nachricht wenn keine Projektnummer.
- Positionen: typische Muster "12m Kupferrohr", "3 Stück Wandscheibe DN20", "5x Fitting", "10 lfm Rohr". Menge als Zahl (Komma zu Punkt), Einheit normalisiert ("Stück" → "Stk.", "lfm" = laufende Meter, "m" = Meter, "kg" = Kilogramm).
- Artikelnummer: nur übernehmen wenn explizit genannt ("Art-Nr 12345", "Artikelnummer ABC-123"). Sonst null.
- Mehrere Positionen in einer Nachricht → als Array erfassen.
- Wenn nur "Material: X" ohne Menge → trotzdem erfassen, einheit = "Stk.", menge = 1, der User kann's noch anpassen.
- Spracherkennungs-/Diktierfehler: offensichtliche Fehler korrigieren (z.B. "Kupferrhor" → "Kupferrohr", "Profipressböngen" → "Profipressbogen").${ctx}`;
}

// Extrahiert das JSON aus dem KI-Output. Reihenfolge:
//   1) JSON in ```...```-Codeblock (mit Brace-Balancing für nested Objects)
//   2) Roher JSON-Block im Text (gleiche Brace-Balancing-Logik)
//   3) Markdown-Fallback: parst eine "**Projekt-Nr.:** X"-Antwort
function extrahiereJson(text) {
  // 1) JSON in Markdown-Codeblock
  const mdMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (mdMatch) {
    const inner = mdMatch[1];
    const obj = versucheJsonMitBraceBalancing(inner);
    if (obj) return obj;
  }
  // 2) Roher JSON-Block: erstes { bis zum BALANCIERTEN }
  const obj = extrahiereOuterstesJsonObj(text);
  if (obj) return obj;
  // 3) Fallback: Markdown-Format parsen (für Modelle, die kein JSON liefern)
  const mdResult = extrahiereAusMarkdown(text);
  if (mdResult) return mdResult;

  // Detailliertes Loggen
  console.error('extrahiereJson: kein JSON+kein Markdown-Pattern gefunden. KI-Output (erste 500 Zeichen):');
  console.error(text.slice(0, 500));
  throw new Error('Konnte kein JSON in der KI-Antwort finden: ' + text.slice(0, 200));
}

// Findet das erste top-level JSON-Objekt in einem String und parst es.
// Nutzt Brace-Counting, um das passende close-brace zu finden, damit
// nested Objects (z.B. positionen als Array) korrekt erkannt werden.
function extrahiereOuterstesJsonObj(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end <= start) return null;
  return versucheJsonMitBraceBalancing(text.substring(start, end + 1));
}

function versucheJsonMitBraceBalancing(candidate) {
  try { return JSON.parse(candidate); } catch { return null; }
}

// Fallback-Parser: extrahiert Daten aus einer Markdown-formatierten Antwort
// wie "**Projekt-Nr.:** 26-0311" und einer Pipe-Tabelle mit Positionen.
function extrahiereAusMarkdown(text) {
  if (!text || typeof text !== 'string') return null;
  // Muss mindestens einen unserer Marker enthalten
  if (!/projekt|bezeichnung|position/i.test(text)) return null;

  const projekt = { nummer: null, bezeichnung: null };
  const positionen = [];

  // Projektnummer: "**Projekt-Nr.:** 26-0311" oder "Projektnummer: 26-0311"
  const nrMatch = text.match(/Projekt[- ]?Nr\.?:?\s*\*?\*?\s*([A-Za-z0-9][\w./-]{1,30})/i);
  if (nrMatch) projekt.nummer = nrMatch[1].trim();

  // Bezeichnung: "**Bezeichnung:** Umbau Trinkwasser" oder "Bezeichnung: ..."
  const bezMatch = text.match(/Bezeichnung:?\s*\*?\*?\s*([^\n*]+?)(?=\n|$|\*\*)/i);
  if (bezMatch) projekt.bezeichnung = bezMatch[1].trim().replace(/\*+$/, '');

  // Tabelle mit Positionen: | Nr | Material | Menge | Einheit |
  // Wir suchen nach Zeilen, die mit | beginnen und Zahlen + Wörter enthalten.
  const zeilen = text.split('\n');
  for (const zeile of zeilen) {
    const trimmed = zeile.trim();
    if (!trimmed.startsWith('|')) continue;
    // Header-Zeile oder Separator überspringen
    if (/\|[-\s]+\|/.test(trimmed)) continue;
    if (/Pos\.|Material|Menge|Einheit/i.test(trimmed)) continue;

    // Spalten splitten
    const zellen = trimmed.split('|').map((s) => s.trim()).filter(Boolean);
    if (zellen.length < 3) continue;

    // Erwartete Reihenfolge: Nr, Material, Menge, Einheit, [Art-Nr]
    const posNr = zellen[0];
    // Header-Zeile mit "Nr" überspringen
    if (posNr.toLowerCase() === 'nr' || posNr.toLowerCase() === 'pos.') continue;
    if (!/^\d+$/.test(posNr)) continue;

    const name = zellen[1] || '';
    const mengeRaw = zellen[2] || '';
    const einheit = (zellen[3] || 'Stk.').replace(/\.$/, '');
    const artikelnummer = zellen[4] || null;

    const menge = parseFloat(mengeRaw.replace(',', '.'));
    if (isNaN(menge)) continue;

    positionen.push({
      name,
      menge,
      einheit,
      artikelnummer: artikelnummer || null
    });
  }

  if (!projekt.nummer && !projekt.bezeichnung && positionen.length === 0) return null;
  return {
    projekt,
    positionen,
    vollstaendig: !!(projekt.nummer && projekt.bezeichnung && positionen.length > 0),
    fehlt: []
  };
}

async function generiereAufmassPdf(chatId, daten) {
  const outputDir = path.join(SESSION_ORDNER(chatId), 'aufnahmen');
  fs.mkdirSync(outputDir, { recursive: true });
  const datum = new Date().toISOString().slice(0, 10);
  const projSafe = (daten.projekt && daten.projekt.nummer || 'ohne-nr').replace(/[^A-Za-z0-9_-]/g, '_');
  const outputPfad = path.join(outputDir, `Aufmass_${projSafe}_${datum}.pdf`);

  const vorlage = findeVorlage();
  if (vorlage && await libPdfReader.hatAcroFormFelder(vorlage)) {
    const feldNamen = await libPdfFiller.ladeFeldNamen(vorlage);
    const feldwerte = mappeDatenAufFelder(feldNamen, daten);
    return await libPdfFiller.fuelleFelder(vorlage, feldwerte, outputPfad);
  }

  return await libPdf.erstelleAufmass(daten, outputPfad);
}

function mappeDatenAufFelder(feldNamen, daten) {
  // Direktes Mapping auf das Zienert-AcRoForm-Schema:
  //   Kopf:       projekt_nr, bauvorhaben, seite, seite_von
  //   Zeile N:    pos_N, menge_N, me_N, artikelnr_N, bezeichnung_N, ep_N, gp_N
  //   Fuß:        datum, unterschrift_kunde, unterschrift_monteur
  //
  // Felder, die nicht zu unserer Datenstruktur passen, bleiben leer.

  const map = {};
  const projekt = daten.projekt || {};
  const positionen = Array.isArray(daten.positionen) ? daten.positionen : [];

  for (const f of feldNamen) {
    if (f === 'projekt_nr') {
      map[f] = String(projekt.nummer || '');
    } else if (f === 'bauvorhaben') {
      map[f] = String(projekt.bezeichnung || '');
    } else if (f === 'seite' || f === 'seite_von') {
      // Wird vom User meist nicht im Chat diktiert — leer lassen oder mit Anzahl füllen
      // seite = "1", seite_von = "1" für die erste Seite (typischer Aufmaßzettel)
      map[f] = '';
    } else if (f === 'datum') {
      map[f] = new Date().toLocaleDateString('de-DE');
    } else if (f === 'unterschrift_kunde' || f === 'unterschrift_monteur') {
      // Unterschriften kommen entweder als Bild rein (über die AcroForm-Behandlung)
      // oder bleiben leer — der User unterschreibt das PDF normal nach dem Druck
      map[f] = '';
    } else {
      // Positionszeilen-Felder: pos_N, menge_N, me_N, artikelnr_N, bezeichnung_N, ep_N, gp_N
      const m = f.match(/^(pos|menge|me|artikelnr|bezeichnung|ep|gp)_(\d+)$/);
      if (m) {
        const feldName = m[1];
        const zeile = parseInt(m[2], 10);
        const pos = positionen[zeile - 1]; // Zeile 1 = positionen[0]
        if (pos) {
          switch (feldName) {
            case 'pos':
              map[f] = String(zeile);
              break;
            case 'menge':
              map[f] = pos.menge !== null && pos.menge !== undefined ? String(pos.menge) : '';
              break;
            case 'me':
              map[f] = String(pos.einheit || '');
              break;
            case 'artikelnr':
              map[f] = String(pos.artikelnummer || '');
              break;
            case 'bezeichnung':
              map[f] = String(pos.name || '');
              break;
            case 'ep':
              // Einzelpreis — nur setzen, wenn in den Daten vorhanden
              map[f] = pos.einzelpreis !== null && pos.einzelpreis !== undefined
                ? String(pos.einzelpreis) : '';
              break;
            case 'gp':
              // Gesamtpreis: wenn EP+Menge da, automatisch berechnen
              if (pos.gesamtpreis !== null && pos.gesamtpreis !== undefined) {
                map[f] = String(pos.gesamtpreis);
              } else if (pos.einzelpreis && pos.menge) {
                const gp = (parseFloat(pos.einzelpreis) * parseFloat(pos.menge)).toFixed(2);
                map[f] = gp.replace('.', ',');
              } else {
                map[f] = '';
              }
              break;
          }
        }
        // Wenn keine Position für diese Zeile da ist, lassen wir das Feld leer
      }
      // Andere unbekannte Felder (z.B. falls das Schema mal erweitert wird) bleiben leer
    }
  }
  return map;
}

function baueStatus(daten) {
  const lines = ['*Aktueller Stand:*'];
  if (daten.projekt) {
    if (daten.projekt.nummer) lines.push('• Projektnummer: ' + daten.projekt.nummer);
    if (daten.projekt.bezeichnung) lines.push('• Bezeichnung: ' + daten.projekt.bezeichnung);
  }
  if (Array.isArray(daten.positionen) && daten.positionen.length > 0) {
    lines.push('• Positionen (' + daten.positionen.length + '):');
    daten.positionen.forEach((p, i) => {
      const art = p.artikelnummer ? ' (Art-Nr ' + p.artikelnummer + ')' : '';
      lines.push('   ' + (i + 1) + '. ' + p.menge + ' ' + p.einheit + ' ' + p.name + art);
    });
  } else {
    lines.push('• Positionen: (noch keine)');
  }
  return lines.join('\n');
}

function fehltEtwas(daten) {
  return !daten.projekt || !daten.projekt.nummer || !daten.projekt.bezeichnung ||
         !Array.isArray(daten.positionen) || daten.positionen.length === 0;
}

function fehltWas(daten) {
  const f = [];
  if (!daten.projekt || !daten.projekt.nummer) f.push('Projektnummer');
  if (!daten.projekt || !daten.projekt.bezeichnung) f.push('Bezeichnung');
  if (!Array.isArray(daten.positionen) || daten.positionen.length === 0) f.push('mindestens 1 Position');
  return f;
}

module.exports = {
  id: 'materialaufmass',
  name: 'Materialaufmaß',
  emoji: '📐',
  description: 'Extrahiert Materialaufmaß-Daten aus deiner Nachricht, fragt nur nach wenn was fehlt, und generiert das PDF (mit Mustervorlage + Style-Sheet + Unterschrift).',
  triggers: [
    'aufmaß', 'aufmass', 'aufmassen', 'aufmesse', 'aufnahme', 'massaufnahme',
    'materialaufmaß', 'materialaufmass',
    'verlegt', 'montiert', 'angeschlossen', 'eingebaut', 'versetzt', 'gesetzt',
    'mengenermittlung', 'massenermittlung',
    'lfm', 'stück', 'stk',
    'position', 'positionen', 'posten'
  ],
  systemPromptAdd: `MATERIALAUFMASS-EXPERTE AKTIV.
Der User schickt eine Nachricht mit Aufmaß-Daten (Projektnummer, Bezeichnung, Positionen). Du extrahierst ALLES daraus und gibst es als JSON zurück. KEIN freier Text, KEIN Format-Text, KEIN "Hier ist dein Aufmaß:" — nur JSON.

WICHTIG: Antworte NUR mit einem JSON-Objekt. Kein Kommentar davor oder danach. Falls die Nachricht keine Aufmaß-Daten enthält (User schreibt etwas anderes), gib trotzdem ein leeres JSON-Gerüst zurück mit vollstaendig:false und fehlt:["Projektnummer","Bezeichnung","Positionen"].`,
  tools: null,
  implementiert: true,

  // Wird vom Bot VOR der Trigger-Erkennung aufgerufen. Sagt, ob für diesen
  // User gerade eine Aufmaß-Session läuft (permanente JSON-Datei), damit
  // Trigger-freie Nachrichten ("fertig", "pdf bitte", "ändere Position 2")
  // trotzdem beim Materialaufmaß-Experten landen.
  hatAktiveSession: function(chatId) {
    const s = ladeSession(chatId);
    if (!s) return false;
    // Eine Session gilt als "aktiv", wenn sie schon irgendwas erfasst hat
    // (Projektnummer, Bezeichnung oder mindestens 1 Position). Solange
    // die Session nur aus einem leeren Stub besteht, soll der Trigger
    // weiterhin den normalen Flow starten.
    return !!(s.projekt && (s.projekt.nummer || s.projekt.bezeichnung))
      || (Array.isArray(s.positionen) && s.positionen.length > 0);
  },

  async verarbeite(input, kontext) {
    const { chatId, text, dokInhalt, systemPrompt, gedaechtnisText } = input;
    const userText = String(text || '').trim();
    const norm = userText.toLowerCase();

    // Abbruch
    if (/^(stop|abbrechen|abbruch|reset|vergiss\s*es)/.test(norm)) {
      loescheSession(chatId);
      return { antwort: 'Aufmaß-Session verworfen. Du kannst jederzeit neu starten.' };
    }

    // Bestehende Session laden (für Anpassungen)
    const existingSession = ladeSession(chatId);

    // KI-Aufruf zur JSON-Extraktion (1 Anfrage, nicht iterativ)
    const extractionsSystem = baueSystemPromptFuerExtraktion(existingSession);
    const fullPrompt = (systemPrompt || '') + '\n\n' + extractionsSystem;

    let extrahiert;
    try {
      const raw = await kontext.mainChat(fullPrompt, userText);
      extrahiert = extrahiereJson(raw);
    } catch (err) {
      schreibeEintrag('Fehler', `Materialaufmaß JSON-Extraktion fehlgeschlagen (${chatId}): ${err.message}`);
      return { antwort: 'Fehler beim Auswerten deiner Eingabe. Bitte nochmal mit klarer Form: Projektnummer, Bezeichnung, dann die Positionen (Menge + Einheit + Materialname).' };
    }

    // Validierung
    if (!extrahiert || typeof extrahiert !== 'object') {
      return { antwort: 'Konnte keine strukturierten Daten extrahieren. Bitte schick das Aufmaß in der Form: „PRJ-NR, Bezeichnung, 12m Kupferrohr 22mm, 3 Wandscheiben DN20, …"' };
    }

    // Hat die KI tatsächlich neue Daten extrahiert? Wenn nicht, behalte die
    // existierende Session unverändert. Wichtig: sonst würde eine Bestätigung
    // wie "passt, jetzt als pdf" die Session leeren und das PDF nie generiert.
    const neuePositionen = Array.isArray(extrahiert.positionen) ? extrahiert.positionen : [];
    const neuesProjekt = extrahiert.projekt || {};
    const hatNeueDaten = neuePositionen.length > 0
      || neuesProjekt.nummer
      || neuesProjekt.bezeichnung;

    if (hatNeueDaten) {
      // Session aktualisieren
      speichereSession(chatId, {
        zuletztGeaendert: new Date().toISOString(),
        projekt: neuesProjekt,
        positionen: neuePositionen
      });
    }
    // Wenn keine neuen Daten: existierende Session behalten (wenn vorhanden)

    // Aktuelle Daten für die folgenden Checks verwenden — entweder die alten
    // aus existingSession oder die gerade aktualisierten.
    const aktuelleDaten = hatNeueDaten
      ? extrahiert
      : (existingSession || extrahiert);

    // Prüfen, ob was fehlt — gegen die aktuellen (ggf. erhaltenen) Daten
    if (fehltEtwas(aktuelleDaten)) {
      const fehlt = fehltWas(aktuelleDaten);
      return {
        antwort: 'Ich habe bisher:\n\n' + baueStatus(aktuelleDaten) +
                 '\n\n⚠️ Es fehlt noch: *' + fehlt.join(', ') + '*.\n\n' +
                 'Schick mir die fehlenden Infos einfach in einer Nachricht — am besten alles auf einmal.'
      };
    }

    // Alles da — prüfen, ob Vorlage/Unterschrift da sind
    const fehltRessourcen = [];
    if (!findeVorlage()) fehltRessourcen.push('aufnahme_vorlage');
    if (!libUnterschrift.hatUnterschrift(chatId)) fehltRessourcen.push('Unterschrift-Bild');

    if (fehltRessourcen.length > 0) {
      const daten = {
        titel: 'Materialaufmaß',
        untertitel: aktuelleDaten.projekt.bezeichnung,
        projekt: aktuelleDaten.projekt,
        positionen: aktuelleDaten.positionen
      };
      let msg = 'Daten vollständig:\n\n' + baueStatus(daten) +
                '\n\n⚠️ Mir fehlen aber noch: *' + fehltRessourcen.join(', ') + '*\n';
      if (fehltRessourcen.includes('aufnahme_vorlage')) {
        msg += '\n• Schick mir die *Muster-PDF* (Aufmaß-Vorlage) als Dokument. Es kommt unter `data/aufnahme_vorlage/`.\n';
      }
      if (fehltRessourcen.includes('Unterschrift-Bild')) {
        msg += '\n• Schick mir ein *Foto deiner Unterschrift*. Es wird unter `data/users/<chatId>/unterschrift.png` gespeichert.\n';
      }
      msg += '\nSobald beides da ist, schick „fertig" oder einfach nochmal — dann erstelle ich das PDF.';
      return { antwort: msg };
    }

    // Alles vorhanden — PDF generieren
    return await generiereUndSende(chatId, aktuelleDaten);
  },

  // Foto-Handler: im Materialaufmaß-Modus speichern wir das Foto als Unterschrift
  async onPhoto(chatId, fileId, msg, kontext) {
    try {
      const link = await kontext.bot.getFileLink(fileId);
      const res = await fetch(link);
      const buffer = Buffer.from(await res.arrayBuffer());
      await libUnterschrift.speichereUnterschrift(chatId, buffer);
      const session = ladeSession(chatId);
      let extra = '';
      if (session) {
        extra = '\n\n_Session-Daten:_ ' + (session.positionen ? session.positionen.length : 0) + ' Positionen erfasst.';
        if (fehltEtwas(session)) {
          extra += ' Es fehlt noch: ' + fehltWas(session).join(', ') + '.';
        } else if (!findeVorlage()) {
          extra += ' Es fehlt noch die Muster-PDF (aufnahme_vorlage).';
        } else {
          extra += ' Schick nochmal, dann erstelle ich das PDF.';
        }
      }
      return { antwort: '✍️ Unterschrift gespeichert.' + extra };
    } catch (err) {
      return { antwort: 'Fehler beim Speichern der Unterschrift: ' + err.message };
    }
  },

  // Dokument-Handler: im Materialaufmaß-Modus speichern wir PDFs in die richtigen Ordner
  async onDocument(chatId, docMimeType, fileName, fileId, kontext) {
    if (docMimeType !== 'application/pdf') {
      return null; // kein PDF, normaler Flow
    }
    try {
      const link = await kontext.bot.getFileLink(fileId);
      const res = await fetch(link);
      const buffer = Buffer.from(await res.arrayBuffer());

      // Welcher Ordner? Wenn Dateiname "aufnahme" oder "vorlage" enthält → vorlage.
      // Sonst Standard: auffordern, es zu präzisieren.
      const fname = (fileName || '').toLowerCase();
      if (/aufnahme|aufmass|vorlage|template|muster/.test(fname)) {
        fs.mkdirSync(VORLAGE_ORDNER, { recursive: true });
        const safeName = (fileName || 'muster.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
        const target = path.join(VORLAGE_ORDNER, safeName);
        fs.writeFileSync(target, buffer);
        return { antwort: '📄 Muster-PDF gespeichert: `data/aufnahme_vorlage/' + safeName + '`.\n\nFalls du schon eine Aufmaß-Session mit allen Daten hattest, schick nochmal — dann generiere ich das PDF.' };
      }
      if (/style|format|formatierung|stylesheet/.test(fname)) {
        fs.mkdirSync(STYLE_ORDNER, { recursive: true });
        const safeName = (fileName || 'style.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
        const target = path.join(STYLE_ORDNER, safeName);
        fs.writeFileSync(target, buffer);
        return { antwort: '🎨 Style-Sheet gespeichert: `data/style_sheet/' + safeName + '`.' };
      }
      return { antwort: 'PDF erkannt, aber ich weiß nicht wohin damit. Sag mir bitte: ist das die *Muster-Vorlage* (fürs Aufmaß) oder das *Style-Sheet* (Formatierung)?' };
    } catch (err) {
      return { antwort: 'Fehler beim Speichern des PDFs: ' + err.message };
    }
  },

  _internals: { ladeSession, speichereSession, loescheSession, findeVorlage, findeStyleSheet, fehltEtwas, fehltWas, baueSystemPromptFuerExtraktion, extrahiereJson, generiereAufmassPdf, mappeDatenAufFelder }
};

// Hilfsimport für Logging
const { schreibeEintrag } = require('../protokoll');

async function generiereUndSende(chatId, daten) {
  try {
    const pdfDaten = {
      titel: 'Materialaufmaß',
      untertitel: daten.projekt && daten.projekt.bezeichnung,
      projekt: daten.projekt,
      positionen: daten.positionen,
      unterschrift: libUnterschrift.getUnterschriftPfad(chatId),
      meta: { erstelltVon: 'Bot', erstelltAm: new Date().toISOString() }
    };
    const pdfPfad = await generiereAufmassPdf(chatId, pdfDaten);
    // Session behalten — User kann noch Anpassungen schicken
    return {
      antwort: '✅ *Materialaufmaß erstellt*: `' + path.basename(pdfPfad) + '`\n\nAnpassungswünsche? Einfach „ändere Position 2 auf 5" o.ä. schicken.',
      _sendDocument: pdfPfad
    };
  } catch (err) {
    return { antwort: 'Fehler beim Erstellen des PDFs: ' + err.message };
  }
}
