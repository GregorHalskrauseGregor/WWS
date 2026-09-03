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

const ABBRUCH_MUSTER = /^\s*(stop|stopp|abbrechen|abbruch|reset|vergiss\s*es|verwerfen)\b/i;

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
        liste.forEach((e, i) => {
          const teile = Object.entries(def.felder || {})
            .map(([n]) => e[n])
            .filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
          zeilen.push(`   ${i + 1}. ${teile.join(' ')}`);
        });
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
    const def = feld && schema[feld];
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

// ─────────────────────────────────────────────────────────── Extraktions-Call

function baueExtraktionsPrompt(experte, daten) {
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
- Gib NUR Operationen für das aus, was in DIESER Nachricht wirklich steht.
- Schon Erfasstes NICHT wiederholen — es bleibt automatisch erhalten.
- "noch 3 Wandscheiben dazu" -> liste_hinzu. "Position 2 auf 5" -> liste_aendere.
  "Position 3 raus" -> liste_entferne. "war doch Heizung" -> setze auf das gemeinte Feld.
- Sagt der Nutzer sinngemäß "passt", "fertig", "stimmt so", "mach das PDF", "ausführen":
  "bestaetigt": true (und meist keine Operationen).
- Sagt er "stop", "abbrechen", "vergiss es": "abbruch": true.
- Enthält die Nachricht gar keine Daten (Smalltalk, Rückfrage): leeres ops-Array.
- Offensichtliche Diktier- und OCR-Fehler still korrigieren.
${experte.extraktionsHinweise ? '\n════════ FACHLICHE HINWEISE ════════\n' + experte.extraktionsHinweise : ''}

════════ ANTWORTFORMAT ════════
AUSSCHLIESSLICH ein JSON-Objekt, kein Markdown, kein Kommentar:

{"ops":[ ... ], "bestaetigt": false, "abbruch": false}`;
}

// ──────────────────────────────────────────────────────────────── Hauptablauf
//
// dienste = { chat(systemPrompt, userText), protokoll(typ, text) }
// Rückgabe ist transport-neutral: { text, dateien, knoepfe, vorgangEnde }

async function verarbeite({ experte, chatId, themaId, text, dokInhalt }, dienste) {
  const schema = experte.schema;
  const eingabe = [String(text || '').trim(), dokInhalt ? `\n\nInhalt der beigefügten Datei:\n${dokInhalt}` : '']
    .join('').trim();

  let vorgang = speicher.lade(chatId, themaId);
  if (!vorgang || vorgang.experteId !== experte.id) {
    vorgang = speicher.starte(chatId, themaId, experte.id);
  }

  // Harter Abbruch ohne KI-Aufruf — spart einen Call bei einem klaren Wort.
  if (ABBRUCH_MUSTER.test(eingabe)) {
    speicher.loesche(chatId, themaId);
    return { text: `${experte.emoji || ''} ${experte.name}: Vorgang verworfen. Du kannst jederzeit neu anfangen.`.trim() };
  }

  // 1) KI schlägt Änderungen vor
  let vorschlag;
  try {
    const roh = await dienste.chat(baueExtraktionsPrompt(experte, vorgang.daten), eingabe);
    vorschlag = extrahiere(roh) || {};
  } catch (err) {
    dienste.protokoll?.('Fehler', `Extraktion ${experte.id} (${chatId}/${themaId}): ${err.message}`);
    return { text: 'Ich konnte deine Angaben gerade nicht auswerten. Schick sie mir bitte nochmal.' };
  }

  if (vorschlag.abbruch === true) {
    speicher.loesche(chatId, themaId);
    return { text: `${experte.emoji || ''} ${experte.name}: Vorgang verworfen.`.trim() };
  }

  // 2) Code wendet an
  const { daten, angewandt, abgelehnt } = wendeOpsAn(vorgang.daten, vorschlag.ops, schema);
  vorgang.daten = daten;
  if (abgelehnt.length) {
    dienste.protokoll?.('Vorgang', `${experte.id}: verworfene Operationen — ${abgelehnt.join('; ')}`);
  }

  // 3) Code prüft gegen das Schema
  const fehlt = fehlendeFelder(daten, schema);
  const kopf = `${experte.emoji || ''} *${experte.name}*`.trim();
  const stand = baueStand(daten, schema);

  if (fehlt.length > 0) {
    vorgang.status = speicher.STATUS.SAMMELT;
    speicher.speichere(chatId, themaId, vorgang);
    const fragen = fehlt.map((f) => f.def.frage || `Was ist ${label(f.feld, f.def)}?`);
    const hinweisAbgelehnt = abgelehnt.length
      ? `\n\n_Nicht übernommen: ${abgelehnt.join(', ')}_`
      : '';
    return {
      text: `${kopf}\n\n*Stand:*\n${stand}\n\n⚠️ Es fehlt noch:\n${fragen.map((f) => '• ' + f).join('\n')}` +
        hinweisAbgelehnt
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
      text: `${kopf}\n\n*Stand:*\n${stand}\n\nAlles da. Soll ich das so ausführen?`,
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
  baueExtraktionsPrompt
};
