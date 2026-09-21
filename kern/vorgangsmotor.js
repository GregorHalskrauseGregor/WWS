// Vorgangs-Motor — das generische "sammeln, nachfragen, ausführen".
//
// Vorher hat sich jeder Experte diese Mechanik selbst gebaut: das Materialaufmaß
// brauchte dafür 639 Zeilen (Session laden, JSON extrahieren, mergen, prüfen was
// fehlt, Stand formatieren, nachfragen). Bestellung und Lager hätten exakt
// dasselbe nochmal gebraucht.
//
// Jetzt liegt der Ablauf einmal hier, und ein Experte deklariert nur noch:
//   schema        — welche Felder es gibt, was Pflicht ist, wie nachgefragt wird
//   finalisiere() — was am Ende passiert (PDF bauen, in Excel buchen, ...)
//
// ABLAUF pro Nachricht:
//   1. KI schlägt ÄNDERUNGEN vor (Delta-Operationen), nicht den ganzen Zustand
//   2. Code wendet die Operationen an und rechnet          <- deterministisch
//   3. Code prüft gegen das Schema, was noch fehlt          <- deterministisch
//   4. fehlt was -> gezielt nachfragen; sonst Stand zeigen und bestätigen lassen
//   5. bestätigt -> finalisiere() des Experten
//
// Warum Delta statt Vollzustand: vorher musste die KI bei jeder Korrektur die
// komplette Positionsliste fehlerfrei neu abschreiben. Vergaß sie eine Zeile,
// war sie weg — und der Prompt wuchs mit jeder Position. Jetzt schickt sie nur
// noch "ändere Position 2 auf Menge 5".

const { extrahiere } = require('./json');
const speicher = require('./vorgang');
const themen = require('../themen');

const ABBRUCH_MUSTER = /^\s*(stop|stopp|abbrechen|abbruch|reset|vergiss\s*es|verwerfen)\b/i;

// Massen-Import aus Dateien: eine Lagerliste mit 150 Zeilen sprengt jedes
// Antwort-Budget, wenn das Modell daraus 150 Operationen in EINEM Zug schreiben
// soll — es liefert dann gar nichts. Deshalb wird ein laengerer Dateiinhalt in
// Haeppchen zerlegt und je Haeppchen extrahiert.
// Kleinere Haeppchen als man denkt: aus 2200 Zeichen werden ~30 Positionen,
// und die passen samt Reasoning nicht zuverlaessig ins Antwort-Budget — in der
// Praxis fiel dann jeder fuenfte Auszug komplett aus. 1200 Zeichen sind sicher.
const DOK_STUECK_ZEICHEN = 1200;
const DOK_MAX_STUECKE = 40;
const DOK_TOKENS = 3000;
const MAX_LISTENEINTRAEGE = 500;
const STAND_MAX_EINTRAEGE = 12;

// ──────────────────────────────────────────────────── Vorgeschichte im Faden
//
// Ein frisch gestarteter Vorgang hat kein Gedaechtnis. Alles, was der Nutzer
// VOR dem Start geschrieben hat, faellt sonst unter den Tisch — und genau das
// passiert im haeufigsten Fall ueberhaupt:
//
//   User:  "bestell 10 Meblerbogen 16, 7 Meblerbogen 45 Grad, ..."
//   Bot:   "Wohin soll geliefert werden?"          <- noch KEIN Vorgang offen
//   User:  "zu in den Wassern 2"
//   Bot:   Vorgang startet — und kennt nur die Adresse. Positionen: keine.
//
// Deshalb bekommt AUSSCHLIESSLICH die erste Extraktion eines neuen Vorgangs die
// letzten Nutzernachrichten desselben Fadens mit. Bei jeder weiteren Nachricht
// waere das schaedlich: dann kaemen schon verbuchte Positionen ein zweites Mal
// an und die Liste haette alles doppelt.
const VORGESCHICHTE_NACHRICHTEN = 3;
const VORGESCHICHTE_ZEICHEN = 4000;

function vorgeschichteDesFadens(chatId, themaId) {
  try {
    const thema = themen.ladeThema(chatId, themaId);
    if (!thema || !Array.isArray(thema.messages)) return '';
    // Die aktuelle Nachricht haengt noch NICHT im Faden — der Orchestrator
    // schreibt sie erst nach der Verarbeitung an. Hier steht also wirklich nur
    // das, was davor gesagt wurde.
    const vom_nutzer = thema.messages
      .filter((m) => m && m.rolle === 'user' && String(m.inhalt || '').trim())
      .slice(-VORGESCHICHTE_NACHRICHTEN);
    if (!vom_nutzer.length) return '';
    let text = vom_nutzer.map((m) => String(m.inhalt).trim()).join('\n--- (naechste Nachricht) ---\n');
    if (text.length > VORGESCHICHTE_ZEICHEN) text = text.slice(-VORGESCHICHTE_ZEICHEN);
    return text;
  } catch {
    return '';
  }
}

// ───────────────────────────────────────────────────────── Schema-Auswertung

function istListe(def) { return def && def.typ === 'liste'; }

function label(feld, def) {
  return (def && def.label) || feld.charAt(0).toUpperCase() + feld.slice(1);
}

// Beschreibt das Schema für die KI, damit sie weiß, welche Felder es gibt.
function schemaAlsText(schema) {
  const zeilen = [];
  for (const [feld, def] of Object.entries(schema)) {
    if (istListe(def)) {
      const unter = Object.entries(def.felder || {})
        .map(([n, t]) => `${n} (${String(t).replace('?', '')}${String(t).endsWith('?') ? ', optional' : ''})`)
        .join(', ');
      zeilen.push(`- ${feld}: LISTE${def.pflicht ? ', PFLICHT' : ', optional'}${def.min ? `, mindestens ${def.min} Eintrag/Einträge` : ''}` +
        `\n    Jeder Eintrag hat: ${unter}` +
        (def.beschreibung ? `\n    ${def.beschreibung}` : ''));
    } else {
      zeilen.push(`- ${feld}: ${def.typ || 'text'}${def.pflicht ? ', PFLICHT' : ', optional'}` +
        (def.beschreibung ? ` — ${def.beschreibung}` : ''));
    }
  }
  return zeilen.join('\n');
}

// Was fehlt noch? Rein deterministisch gegen das Schema geprüft.
function fehlendeFelder(daten, schema) {
  const fehlt = [];
  for (const [feld, def] of Object.entries(schema)) {
    if (!def.pflicht) continue;
    const wert = daten[feld];
    if (istListe(def)) {
      const min = def.min || 1;
      if (!Array.isArray(wert) || wert.length < min) fehlt.push({ feld, def });
    } else if (wert === undefined || wert === null || String(wert).trim() === '') {
      fehlt.push({ feld, def });
    }
  }
  return fehlt;
}

function istVollstaendig(daten, schema) {
  return fehlendeFelder(daten, schema).length === 0;
}

// Menschenlesbarer Stand — generisch aus dem Schema erzeugt, nicht pro Experte.
function baueStand(daten, schema) {
  const zeilen = [];
  for (const [feld, def] of Object.entries(schema)) {
    const wert = daten[feld];
    if (istListe(def)) {
      const liste = Array.isArray(wert) ? wert : [];
      if (liste.length === 0) {
        zeilen.push(`• ${label(feld, def)}: (noch keine)`);
      } else {
        zeilen.push(`• ${label(feld, def)} (${liste.length}):`);
        // Bei einem Import aus einer Datei koennen das hunderte sein — die
        // Bestaetigung soll lesbar bleiben, nicht den Chat fluten.
        const zeigen = liste.slice(0, STAND_MAX_EINTRAEGE);
        zeigen.forEach((e, i) => {
          const teile = Object.entries(def.felder || {})
            .map(([n]) => e[n])
            .filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
          zeilen.push(`   ${i + 1}. ${teile.join(' ')}`);
        });
        if (liste.length > zeigen.length) {
          zeilen.push(`   … und ${liste.length - zeigen.length} weitere`);
        }
      }
    } else if (wert !== undefined && wert !== null && String(wert).trim() !== '') {
      zeilen.push(`• ${label(feld, def)}: ${wert}`);
    }
  }
  return zeilen.length ? zeilen.join('\n') : '(noch nichts erfasst)';
}

// ────────────────────────────────────────────────── Delta-Operationen anwenden
//
// Die KI schlägt vor, der Code führt aus. Ungültige Operationen werden
// verworfen statt geraten — lieber eine Rückfrage als eine falsche Zahl.

function zahl(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(',', '.').trim());
  return isNaN(n) ? null : n;
}

function normalisiereEintrag(eintrag, def) {
  const raus = {};
  for (const [name, typ] of Object.entries(def.felder || {})) {
    let w = eintrag[name];
    if (w === undefined || w === null || String(w).trim() === '') { raus[name] = null; continue; }
    raus[name] = String(typ).startsWith('zahl') ? zahl(w) : String(w).trim();
  }
  return raus;
}

function wendeOpsAn(daten, ops, schema) {
  const neu = JSON.parse(JSON.stringify(daten || {}));
  const angewandt = [];
  const abgelehnt = [];

  for (const op of Array.isArray(ops) ? ops : []) {
    const feld = op && op.feld;
    if (!feld || typeof feld !== 'string') {
      // Leere oder fehlende Feldnamen kommen vor, wenn die KI in einer
      // Korrekturschleife ein op ohne klaren Anker liefert. Das ist ein
      // Modellfehler — den User damit zu behelligen („unbekanntes Feld:
      // undefined") hilft niemandem, also still verwerfen.
      continue;
    }
    const def = schema[feld];
    if (!def) { abgelehnt.push(`unbekanntes Feld: ${feld}`); continue; }

    try {
      switch (op.op) {
        case 'setze': {
          if (istListe(def)) { abgelehnt.push(`${feld} ist eine Liste`); break; }
          const w = String(def.typ || '').startsWith('zahl') ? zahl(op.wert) : op.wert;
          if (w === null || w === undefined || String(w).trim() === '') { abgelehnt.push(`leerer Wert für ${feld}`); break; }
          neu[feld] = w;
          angewandt.push(`${feld} = ${w}`);
          break;
        }
        case 'loesche': {
          delete neu[feld];
          angewandt.push(`${feld} geleert`);
          break;
        }
        case 'liste_hinzu': {
          if (!istListe(def)) { abgelehnt.push(`${feld} ist keine Liste`); break; }
          if (!op.wert || typeof op.wert !== 'object') { abgelehnt.push('Eintrag fehlt'); break; }
          if (!Array.isArray(neu[feld])) neu[feld] = [];
          neu[feld].push(normalisiereEintrag(op.wert, def));
          angewandt.push(`${feld}: Eintrag ${neu[feld].length} hinzugefügt`);
          break;
        }
        case 'liste_aendere': {
          if (!istListe(def) || !Array.isArray(neu[feld])) { abgelehnt.push(`${feld}: keine Liste`); break; }
          const i = Number(op.index) - 1; // KI zählt ab 1, wie der User spricht
          if (!(i >= 0 && i < neu[feld].length)) { abgelehnt.push(`${feld}: Position ${op.index} gibt es nicht`); break; }
          const teil = normalisiereEintrag({ ...neu[feld][i], ...(op.wert || {}) }, def);
          neu[feld][i] = teil;
          angewandt.push(`${feld}: Position ${op.index} geändert`);
          break;
        }
        case 'liste_entferne': {
          if (!istListe(def) || !Array.isArray(neu[feld])) { abgelehnt.push(`${feld}: keine Liste`); break; }
          const i = Number(op.index) - 1;
          if (!(i >= 0 && i < neu[feld].length)) { abgelehnt.push(`${feld}: Position ${op.index} gibt es nicht`); break; }
          neu[feld].splice(i, 1);
          angewandt.push(`${feld}: Position ${op.index} entfernt`);
          break;
        }
        case 'liste_leeren': {
          if (!istListe(def)) { abgelehnt.push(`${feld} ist keine Liste`); break; }
          neu[feld] = [];
          angewandt.push(`${feld} geleert`);
          break;
        }
        default:
          abgelehnt.push(`unbekannte Operation: ${op.op}`);
      }
    } catch (err) {
      abgelehnt.push(`${op.op} auf ${feld}: ${err.message}`);
    }
  }
  return { daten: neu, angewandt, abgelehnt };
}

// Zerlegt an Zeilengrenzen, damit keine Tabellenzeile zerschnitten wird.
function stueckle(text, max = DOK_STUECK_ZEICHEN) {
  const zeilen = String(text || '').split('\n');
  const stuecke = [];
  let aktuell = '';
  for (const z of zeilen) {
    if (aktuell.length + z.length + 1 > max && aktuell) {
      stuecke.push(aktuell);
      aktuell = '';
    }
    aktuell += (aktuell ? '\n' : '') + z;
    if (stuecke.length >= DOK_MAX_STUECKE) break;
  }
  if (aktuell && stuecke.length < DOK_MAX_STUECKE) stuecke.push(aktuell);
  return stuecke;
}

// Eigener Prompt fuer Dateiauszuege: nur Listeneintraege, kein Zustand im
// Kontext. Der waechst sonst mit jedem Haeppchen und frisst das Budget.
function baueDokumentPrompt(experte, listenFeld, teil, gesamt) {
  const def = experte.schema[listenFeld];
  const unter = Object.entries(def.felder || {})
    .map(([n, t]) => `${n} (${String(t).replace('?', '')}${String(t).endsWith('?') ? ', optional' : ''})`)
    .join(', ');

  return `Du liest Auszug ${teil} von ${gesamt} aus einer Datei (Lagerliste, Lieferschein oder Tabelle) und wandelst JEDE Artikelzeile in einen Listeneintrag um.

Jeder Eintrag hat: ${unter}

Regeln:
- NUR Artikelzeilen. Ueberschriften, Spaltenkoepfe, Summen- und Leerzeilen ueberspringen.
- Jede Artikelzeile wird GENAU EIN Eintrag. Nichts zusammenfassen, nichts weglassen.
- Ohne erkennbare Menge: menge 1.
- Enthaelt der Auszug keine Artikelzeile, gib ein leeres ops-Array zurueck.
${experte.extraktionsHinweise ? '\nFACHLICHE HINWEISE:\n' + experte.extraktionsHinweise : ''}

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, kein Markdown, kein Kommentar:

{"ops":[{"op":"liste_hinzu","feld":"${listenFeld}","wert":{...}}, ...]}`;
}

// ─────────────────────────────────────────────────────────── Extraktions-Call

function baueExtraktionsPrompt(experte, daten, wissensText, expertenKontext, vorgeschichte) {
  const schema = experte.schema;
  const standJetzt = Object.keys(daten || {}).length
    ? JSON.stringify(daten, null, 2)
    : '(noch leer)';

  return `Du bist der Daten-Extraktor für: ${experte.name}.
Deine Aufgabe: aus der Nachricht des Nutzers ABLEITEN, welche ÄNDERUNGEN am aktuellen Stand vorzunehmen sind.

Du gibst NICHT den ganzen Datenstand zurück, sondern nur die Änderungen als Operationen.

════════ FELDER ════════
${schemaAlsText(schema)}

════════ AKTUELLER STAND ════════
${standJetzt}

════════ OPERATIONEN ════════
- {"op":"setze","feld":"<name>","wert":<wert>}                      einfaches Feld setzen/überschreiben
- {"op":"liste_hinzu","feld":"<name>","wert":{...}}                 neuen Listeneintrag anhängen
- {"op":"liste_aendere","feld":"<name>","index":2,"wert":{...}}     Eintrag 2 ändern (nur genannte Unterfelder)
- {"op":"liste_entferne","feld":"<name>","index":3}                 Eintrag 3 löschen
- {"op":"liste_leeren","feld":"<name>"}                             ganze Liste verwerfen
- {"op":"loesche","feld":"<name>"}                                  einfaches Feld leeren

WICHTIG zu index: der Nutzer zählt ab 1, genau wie im angezeigten Stand. "Position 2" ist index 2.

════════ REGELN ════════
- Gib NUR Operationen für das aus, was in DIESER Nachricht wirklich steht${vorgeschichte ? ' ODER im Abschnitt VORGESCHICHTE' : ''}.
- Schon Erfasstes NICHT wiederholen — es bleibt automatisch erhalten.
- "noch 3 Wandscheiben dazu" -> liste_hinzu. "Position 2 auf 5" -> liste_aendere.
  "Position 3 raus" -> liste_entferne. "war doch Heizung" -> setze auf das gemeinte Feld.
- Sagt der Nutzer sinngemäß "passt", "fertig", "stimmt so", "mach das PDF", "ausführen":
  "bestaetigt": true (und meist keine Operationen).
- Sagt er "stop", "abbrechen", "vergiss es": "abbruch": true.
- Enthält die Nachricht gar keine Daten (Smalltalk, Rückfrage): leeres ops-Array.
- Offensichtliche Diktier- und OCR-Fehler still korrigieren.
${vorgeschichte ? `
════════ VORGESCHICHTE ════════
Diese Nachrichten hat der Nutzer unmittelbar VOR dieser hier geschrieben. Sie
sind noch in KEINEN Stand eingeflossen — der Vorgang beginnt gerade erst.

${vorgeschichte}

Nimm daraus alles mit, was zu diesem Vorgang gehört (Positionen, Mengen, Namen,
Nummern). Was nicht zum Vorgang gehört, lässt du weg. Widersprechen sich
Vorgeschichte und aktuelle Nachricht, gilt die AKTUELLE Nachricht.` : ''}
${experte.extraktionsHinweise ? '\n════════ FACHLICHE HINWEISE ════════\n' + experte.extraktionsHinweise : ''}
${wissensText ? '\n════════ ' + wissensText : ''}
${expertenKontext ? '\n════════ LAGE VOR ORT ════════\n' + expertenKontext : ''}

════════ ANTWORTFORMAT ════════
AUSSCHLIESSLICH ein JSON-Objekt, kein Markdown, kein Kommentar:

{"ops":[ ... ], "bestaetigt": false, "abbruch": false}`;
}

// Erstes Listenfeld des Schemas — dorthin wandern Zeilen aus einer Datei.
function listenFeldVon(schema) {
  const treffer = Object.entries(schema).find(([, def]) => istListe(def));
  return treffer ? treffer[0] : null;
}

// Liest eine laengere Datei stueckweise aus und sammelt die Listeneintraege.
async function extrahiereAusDokument(experte, dokInhalt, dienste) {
  const listenFeld = listenFeldVon(experte.schema);
  if (!listenFeld) return { ops: [], stuecke: 0, fehler: 0 };

  const stuecke = stueckle(dokInhalt);
  const ops = [];
  let fehler = 0;

  for (let i = 0; i < stuecke.length; i++) {
    const prompt = baueDokumentPrompt(experte, listenFeld, i + 1, stuecke.length);
    let teil = null;

    // Ein zweiter Versuch je Auszug. Reasoning-Modelle liefern gelegentlich eine
    // leere Antwort; beim Lagerbestand waere jede stillschweigend verlorene
    // Zeile ein falscher Bestand.
    for (let versuch = 0; versuch < 2 && !teil; versuch++) {
      try {
        teil = extrahiere(await dienste.chat(prompt, stuecke[i], { maxTokens: DOK_TOKENS }));
      } catch (err) {
        dienste.protokoll?.('Fehler',
          `Dateiauszug ${i + 1}/${stuecke.length} (${experte.id}), Versuch ${versuch + 1}: ${err.message}`);
      }
    }
    if (!teil || !Array.isArray(teil.ops)) {
      fehler++;
      dienste.protokoll?.('Warnung',
        `Dateiauszug ${i + 1}/${stuecke.length} (${experte.id}) lieferte nichts Verwertbares.`);
      continue;
    }
    for (const op of teil.ops) {
      if (ops.length >= MAX_LISTENEINTRAEGE) break;
      ops.push({ ...op, feld: listenFeld, op: 'liste_hinzu' });
    }
    if (ops.length >= MAX_LISTENEINTRAEGE) break;
  }
  return { ops, stuecke: stuecke.length, fehler };
}

// ──────────────────────────────────────────────────────────────── Hauptablauf
//
// dienste = { chat(systemPrompt, userText), protokoll(typ, text) }
// Rückgabe ist transport-neutral: { text, dateien, knoepfe, vorgangEnde }

async function verarbeite({ experte, chatId, themaId, text, dokInhalt, wissensText }, dienste) {
  const schema = experte.schema;
  const dok = String(dokInhalt || '').trim();
  // Kurze Anhaenge wandern in die normale Extraktion, lange werden separat und
  // stueckweise gelesen — sonst passt die Antwort nicht ins Token-Budget.
  const grosseDatei = dok.length > DOK_STUECK_ZEICHEN;
  const eingabe = grosseDatei
    ? String(text || '').trim()
    : [String(text || '').trim(), dok ? `\n\nInhalt der beigefügten Datei:\n${dok}` : ''].join('').trim();

  let vorgang = speicher.lade(chatId, themaId);
  const vorgangIstNeu = !vorgang || vorgang.experteId !== experte.id;
  if (vorgangIstNeu) {
    vorgang = speicher.starte(chatId, themaId, experte.id);
  }

  // Siehe Kopf von vorgeschichteDesFadens(): nur beim ersten Mal.
  const vorgeschichte = vorgangIstNeu ? vorgeschichteDesFadens(chatId, themaId) : '';
  if (vorgeschichte) {
    dienste.protokoll?.('Vorgang',
      `${experte.id}: neuer Vorgang, ${vorgeschichte.length} Zeichen Vorgeschichte aus dem Faden mitgelesen`);
  }

  // Harter Abbruch ohne KI-Aufruf — spart einen Call bei einem klaren Wort.
  // Geprueft wird die AKTUELLE Nachricht, nicht die Vorgeschichte: ein
  // "abbrechen" von vorhin darf den neuen Vorgang nicht gleich wieder killen.
  if (ABBRUCH_MUSTER.test(String(text || '').trim())) {
    speicher.loesche(chatId, themaId);
    return { text: `${experte.emoji || ''} ${experte.name}: Vorgang verworfen. Du kannst jederzeit neu anfangen.`.trim() };
  }

  // 1) KI schlägt Änderungen vor — aus der Nachricht ...
  let vorschlag = {};
  if (eingabe || vorgeschichte) {
    try {
      // Ein Experte darf vor der Extraktion Kontext beisteuern, den nur er kennt.
      // Beim Lager sind das die Schreibweisen, die zu dieser Nachricht passen —
      // damit die KI die Position gleich richtig benennt, statt eine zweite
      // Zeile fuer denselben Artikel anzulegen und sie hinterher zu mergen.
      let expertenKontext = '';
      if (typeof experte.kontextFuer === 'function') {
        try {
          expertenKontext = (await experte.kontextFuer({ text, chatId, themaId, daten: vorgang.daten })) || '';
        } catch (err) {
          dienste.protokoll?.('Fehler', `kontextFuer(${experte.id}): ${err.message}`);
        }
      }
      vorschlag = extrahiere(await dienste.chat(
        baueExtraktionsPrompt(experte, vorgang.daten, wissensText, expertenKontext, vorgeschichte), eingabe)) || {};
    } catch (err) {
      dienste.protokoll?.('Fehler', `Extraktion ${experte.id} (${chatId}/${themaId}): ${err.message}`);
      return { text: 'Ich konnte deine Angaben gerade nicht auswerten. Schick sie mir bitte nochmal.' };
    }
  }

  if (vorschlag.abbruch === true) {
    speicher.loesche(chatId, themaId);
    return { text: `${experte.emoji || ''} ${experte.name}: Vorgang verworfen.`.trim() };
  }

  // ... und, bei einer groesseren Datei, stueckweise aus deren Inhalt.
  let dokOps = [];
  let dokBericht = null;
  if (grosseDatei) {
    const r = await extrahiereAusDokument(experte, dok, dienste);
    dokOps = r.ops;
    dokBericht = r;
    dienste.protokoll?.('Vorgang',
      `${experte.id}: Datei in ${r.stuecke} Auszug/Auszuegen gelesen, ` +
      `${dokOps.length} Zeile(n) erkannt${r.fehler ? `, ${r.fehler} Auszug/Auszuege ohne Ergebnis` : ''}`);
  }

  // Eine Datei ohne verwertbaren Inhalt darf nicht als "nichts angegeben"
  // durchgehen — sonst fragt der Bot alles ab, was in der Datei steht.
  if (grosseDatei && dokOps.length === 0) {
    return {
      text: `${experte.emoji || ''} *${experte.name}*\n\n`.trim() +
        `\n\n⚠️ Aus der Datei konnte ich keine Artikelzeilen lesen ` +
        `(${dokBericht.stuecke} Auszug/Auszüge geprüft).\n\n` +
        `Hilfreich ist eine Tabelle mit einer Zeile je Artikel und erkennbarer ` +
        `Menge und Bezeichnung. Du kannst mir die Positionen auch einfach schreiben ` +
        `oder diktieren.`
    };
  }

  // 2) Code wendet an
  const alleOps = [...(Array.isArray(vorschlag.ops) ? vorschlag.ops : []), ...dokOps];
  const { daten, angewandt, abgelehnt } = wendeOpsAn(vorgang.daten, alleOps, schema);
  vorgang.daten = daten;
  if (abgelehnt.length) {
    dienste.protokoll?.('Vorgang', `${experte.id}: verworfene Operationen — ${abgelehnt.join('; ')}`);
  }

  // 3) Code prüft gegen das Schema
  const fehlt = fehlendeFelder(daten, schema);
  const kopf = `${experte.emoji || ''} *${experte.name}*`.trim();
  const stand = baueStand(daten, schema);

  // Ein unvollstaendiger Import muss auffallen. Ein Lagerbestand, dem still
  // ein Fuenftel fehlt, ist schlimmer als ein sichtbarer Fehlschlag.
  const importWarnung = (dokBericht && dokBericht.fehler > 0)
    ? `\n\n⚠️ *Unvollständig:* ${dokBericht.fehler} von ${dokBericht.stuecke} Auszügen der Datei ` +
      `konnte ich nicht lesen. Es fehlen also vermutlich Zeilen. Prüf die Liste unten, ` +
      `bevor du bestätigst — oder schick die Datei nochmal.`
    : '';

  if (fehlt.length > 0) {
    vorgang.status = speicher.STATUS.SAMMELT;
    speicher.speichere(chatId, themaId, vorgang);
    const fragen = fehlt.map((f) => f.def.frage || `Was ist ${label(f.feld, f.def)}?`);
    const hinweisAbgelehnt = abgelehnt.length
      ? `\n\n_Nicht übernommen: ${abgelehnt.join(', ')}_`
      : '';
    return {
      text: `${kopf}\n\n*Stand:*\n${stand}${importWarnung}` +
        `\n\n⚠️ Es fehlt noch:\n${fragen.map((f) => '• ' + f).join('\n')}` + hinweisAbgelehnt
    };
  }

  // 4) Vollständig — bestätigen lassen, bevor etwas Bleibendes passiert
  // Ausgeführt wird nur auf ausdrückliche Bestätigung — nie allein deshalb,
  // weil die Daten vollständig sind. Sonst löst eine Nachricht, die zufällig
  // das letzte Pflichtfeld füllt, gleich das PDF oder die Lagerbuchung aus.
  if (vorschlag.bestaetigt !== true) {
    vorgang.status = speicher.STATUS.WARTET_BESTAETIGUNG;
    speicher.speichere(chatId, themaId, vorgang);
    return {
      text: `${kopf}\n\n*Stand:*\n${stand}${importWarnung}\n\nAlles da. Soll ich das so ausführen?`,
      knoepfe: [
        { text: '✅ Ja, ausführen', daten: `vorgang_ok:${themaId}` },
        { text: '❌ Abbrechen', daten: `vorgang_stop:${themaId}` }
      ]
    };
  }

  return fuehreAus({ experte, chatId, themaId, vorgang }, dienste);
}

// Der letzte Schritt: der Experte macht sein Ding (PDF, Excel-Buchung, ...).
async function fuehreAus({ experte, chatId, themaId, vorgang }, dienste) {
  try {
    const ergebnis = await experte.finalisiere(
      { chatId, themaId, daten: vorgang.daten },
      dienste
    );

    // Ein Experte darf am Schluss noch einmal zurueckfragen, statt blind
    // auszufuehren. Gebraucht wird das, wenn sich erst beim Ausfuehren
    // herausstellt, dass es etwas zu entscheiden gibt — etwa: die Haelfte des
    // bestellten Materials liegt im Lager, soll ich das reservieren?
    //
    // Dann bleibt der Vorgang OFFEN. Die naechste Nachricht landet wieder beim
    // selben Experten, statt einen neuen Vorgang anzufangen. Was der Experte in
    // "daten" zurueckgibt, wird mitgespeichert — so muss er die Pruefung beim
    // zweiten Durchgang nicht wiederholen.
    if (ergebnis && ergebnis.vorgangEnde === false) {
      vorgang.status = speicher.STATUS.SAMMELT;
      if (ergebnis.daten && typeof ergebnis.daten === 'object') {
        vorgang.daten = { ...vorgang.daten, ...ergebnis.daten };
      }
      speicher.speichere(chatId, themaId, vorgang);
      return {
        text: ergebnis.text || '',
        dateien: ergebnis.dateien || [],
        knoepfe: ergebnis.knoepfe || [],
        vorgangEnde: false,
        wartetAufEingabe: true
      };
    }

    speicher.loesche(chatId, themaId);
    return {
      text: ergebnis?.text || `${experte.name}: erledigt.`,
      dateien: ergebnis?.dateien || [],
      vorgangEnde: true
    };
  } catch (err) {
    dienste.protokoll?.('Fehler', `finalisiere ${experte.id} (${chatId}/${themaId}): ${err.message}`);
    return {
      text: `${experte.name}: Beim Ausführen ist etwas schiefgegangen — ${err.message}\n\n` +
        `Deine Daten bleiben erhalten, du kannst es nochmal versuchen.`
    };
  }
}

// Wird vom Adapter gerufen, wenn der Nutzer den Bestätigen-Knopf drückt.
async function bestaetigeUeberKnopf({ experte, chatId, themaId }, dienste) {
  const vorgang = speicher.lade(chatId, themaId);
  if (!vorgang) return { text: 'Dieser Vorgang existiert nicht mehr.' };
  if (!istVollstaendig(vorgang.daten, experte.schema)) {
    return { text: 'Es fehlen noch Angaben — der Vorgang wurde nicht ausgeführt.' };
  }
  return fuehreAus({ experte, chatId, themaId, vorgang }, dienste);
}

module.exports = {
  verarbeite,
  bestaetigeUeberKnopf,
  // exportiert für Tests und für Experten, die eigene Anzeigen bauen wollen
  wendeOpsAn,
  fehlendeFelder,
  istVollstaendig,
  baueStand,
  schemaAlsText,
  baueExtraktionsPrompt,
  stueckle,
  extrahiereAusDokument,
  listenFeldVon
};
