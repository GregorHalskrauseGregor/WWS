// 📦 Lager — Vorgangs-Experte für alle Buchungen am Bestand.
//
// Einlagern, Entnehmen, Reservieren und Freigeben in einem Experten: es ist
// derselbe Erfassungsvorgang, nur mit anderer Wirkung am Ende. Das Sammeln der
// Positionen, das Nachfragen bei fehlenden Angaben und die Bestätigung macht
// kern/vorgangsmotor.js.
//
// Gebucht wird erst nach ausdrücklicher Bestätigung — ein Bestand, der sich
// durch eine halb verstandene Nachricht ändert, ist schlimmer als eine Rückfrage.

const material = require('../material');
const libExcel = require('../lib/excel');
const schreibweisen = require('../lib/schreibweisen');
const reservierungen = require('../reservierungen');
const lagerNachricht = require('../lib/lager_nachricht');
const benutzer = require('../benutzer');
const fs = require('fs');
const path = require('path');
const { PFADE } = require('../config');
const { KATEGORIEN } = require('../kategorien');

const RICHTUNGEN = {
  einlagern: 'Bestand erhöhen',
  entnehmen: 'Bestand verringern',
  reservieren: 'für dich vormerken',
  freigeben: 'deine Vormerkung auflösen'
};

function zeile(text) { return '• ' + text; }

// Frueher stand hier eine deterministische Normalisierung: Artikelart raten,
// Material aus der Bezeichnung erkennen, Gebinde in Meter umrechnen.
//
// Das ist jetzt Sache der KI, die dafuer die Wissenskarten im Prompt hat. Grund:
// Fachwissen als Code bedeutet, dass jede Ergaenzung ("eine Stange Kupfer sind
// bei uns 5 m") eine Codeaenderung ist. Als Text in der Wissensbank kann Torsten
// sie selbst schreiben.
//
// Sicher bleibt es, weil die Umrechnung nicht still passiert: die KI schreibt
// beides in die Position — was gesagt wurde und was gebucht wird — und die
// Bestaetigung zeigt es an, bevor irgendetwas in die Excel geht.
//
// Die BEZEICHNUNG bleibt unangetastet. Sie ist die Beschriftung fuer Menschen;
// ein erkanntes Material darf nicht hineingeschrieben werden, sonst wird aus
// "Schwarzrohr DN50" ein "stahl DN50" und die Zeile ist unauffindbar.
function normalisierePositionen(positionen) {
  const hinweise = [];
  for (const p of positionen || []) {
    if (p.umgerechnet_aus) hinweise.push(`${p.bezeichnung}: ${p.umgerechnet_aus} = ${p.menge} ${p.einheit}`);
  }
  return { positionen: positionen || [], hinweise };
}

// Vor der Extraktion: die Zeilen aus dem echten Bestand vorlegen, die zu dieser
// Nachricht passen koennten. Damit entscheidet die KI die Schreibweise, WAEHREND
// sie die Position baut — und nicht der Code hinterher per Stringvergleich.
//
// Nur die passenden Zeilen, nie der ganze Bestand: bei tausend Positionen waere
// das der teuerste Prompt des Programms.
async function schreibweisenKontext(text) {
  try {
    const bestand = await material.leseAlle(PFADE.MATERIAL_XLSX);
    return schreibweisen.alsPromptBlock(schreibweisen.kandidatenFuerText(bestand, text));
  } catch {
    return ''; // noch keine Lagerdatei — dann gibt es auch nichts abzugleichen
  }
}

// Nach jeder Buchung die lesbare Schreibweisen-Liste erneuern. Sie ist ein
// Abbild der Excel, kein zweiter Datenbestand — deshalb wird sie erzeugt und
// nicht gepflegt.
async function erneuereSchreibweisenDoku() {
  try {
    const bestand = await material.leseAlle(PFADE.MATERIAL_XLSX);
    const ziel = path.join(__dirname, '..', 'wissen', 'schreibweisen.md');
    fs.writeFileSync(ziel, schreibweisen.alsMarkdown(bestand), 'utf-8');
  } catch { /* nicht kritisch: die Buchung selbst ist schon durch */ }
}

// ───────────────────────────────────────────────────────────── Ausführung

async function einlagern(daten, chatId) {
  const ergebnisse = await material.addierePositionen(daten.positionen, PFADE.MATERIAL_XLSX);
  if (!ergebnisse.length) {
    return { text: '📦 Nichts eingebucht — bitte Menge und Bezeichnung prüfen.' };
  }
  const zeilen = ergebnisse.map((r) =>
    zeile(`*${r.bezeichnung}* (${r.zustand}): ${r.vorher} → ${r.nachher} ${r.einheit}` +
      (r.neu ? '  _neu angelegt_' : '')));
  return { text: `📦 *Eingelagert*\n${zeilen.join('\n')}` };
}

async function entnehmen(daten, chatId) {
  const ergebnisse = await material.entnehmePositionen(daten.positionen, PFADE.MATERIAL_XLSX, chatId);
  if (!ergebnisse.length) {
    return { text: '🔧 Nichts entnommen — bitte Menge und Bezeichnung prüfen.' };
  }
  const zeilen = ergebnisse.map((r) => {
    if (r.unbekannt) return zeile(`*${r.bezeichnung}*: ⚠️ nicht im Lager (${r.angefragt} angefragt)`);
    let t = zeile(`*${r.bezeichnung}*: ${r.vorher} → ${r.nachher} ${r.einheit}`);
    if (r.gesperrtDurchReservierung > 0) {
      t += `\n   🔒 ${r.gesperrtDurchReservierung} ${r.einheit} sind für jemand anderen reserviert und blieben liegen`;
    }
    const restFehlt = r.fehlend - r.gesperrtDurchReservierung;
    if (restFehlt > 0) t += `\n   ⚠️ ${restFehlt} ${r.einheit} waren nicht auf Lager`;
    return t;
  });
  return { text: `🔧 *Entnommen*\n${zeilen.join('\n')}` };
}

async function reservieren(daten, chatId) {
  const ergebnisse = await material.reservierePositionen(daten.positionen, PFADE.MATERIAL_XLSX, chatId);
  if (!ergebnisse.length) return { text: '🔖 Nichts reserviert — bitte Menge und Bezeichnung prüfen.' };
  const zeilen = ergebnisse.map((r) => {
    if (r.unbekannt) return zeile(`*${r.bezeichnung}*: ⚠️ nicht im Lager`);
    let t = zeile(`*${r.bezeichnung}*: ${r.reserviert} ${r.einheit} für dich vorgemerkt` +
      (r.eigeneReservierung !== r.reserviert ? ` (insgesamt ${r.eigeneReservierung})` : ''));
    if (r.nichtMoeglich > 0) {
      t += `\n   ⚠️ ${r.nichtMoeglich} ${r.einheit} nicht mehr frei ` +
        `(Bestand ${r.bestand}, davon ${r.reserviertGesamt} vorgemerkt)`;
    }
    return t;
  });
  // Was tatsaechlich vorgemerkt werden konnte, wird zum Vorgang mit Nummer —
  // erst dadurch kann der Lagerist sie bestaetigen und der Monteur sie
  // nachschlagen. Nicht vorgemerktes gehoert nicht in den Auftrag: der Lagerist
  // soll nicht nach Material suchen, das der Bot selbst als fehlend kennt.
  const vorgemerkt = ergebnisse
    .filter((r) => !r.unbekannt && r.reserviert > 0)
    .map((r) => ({ bezeichnung: r.bezeichnung, menge: r.reserviert, einheit: r.einheit }));

  let nummer = '';
  if (vorgemerkt.length) {
    const profil = benutzer.ladeProfil(chatId);
    const vorgang = reservierungen.anlegen({
      monteurChatId: chatId,
      monteurName: (profil && profil.displayName) || null,
      positionen: vorgemerkt,
      bemerkung: daten.bemerkung || null
    });
    nummer = `\n\n📋 Nummer *${vorgang.id}* — der Lagerist bekommt sie zur Bestätigung.` +
      '\n_Status jederzeit unter /reservierungen._';
  }

  return {
    text: `🔖 *Reserviert*\n${zeilen.join('\n')}${nummer}` +
      '\n\n_Reserviertes Material ist für andere gesperrt._'
  };
}

async function freigeben(daten, chatId) {
  const ergebnisse = await material.gibReservierungFrei(daten.positionen, PFADE.MATERIAL_XLSX, chatId);
  const zeilen = ergebnisse.map((r) => r.unbekannt
    ? zeile(`*${r.bezeichnung}*: ⚠️ nicht im Lager`)
    : zeile(`*${r.bezeichnung}*: ${r.freigegeben} ${r.einheit} freigegeben` +
        (r.verbleibendeReservierung > 0 ? ` (${r.verbleibendeReservierung} bleiben vorgemerkt)` : '')));
  return { text: `🔓 *Freigegeben*\n${zeilen.join('\n')}` };
}

// ──────────────────────────────────────────────────────────────── Experte

module.exports = {
  id: 'lager',
  name: 'Lager',
  emoji: '📦',
  beschreibung: 'Bucht Material ins Lager ein und wieder aus, und merkt Material für dich vor. Schreibt jede Buchung in die Lagerdatei.',

  zustaendigWenn:
    'Der Nutzer will den Lagerbestand tatsächlich VERÄNDERN: Ware einlagern (etwas ' +
    'Neues kommt dazu), Ware entnehmen (etwas wird rausgenommen, verbraucht, gebraucht, ' +
    'weggegeben), Ware für sich oder andere reservieren (vormerken für später) oder ' +
    'eine bestehende Reservierung wieder freigeben. Der Antrieb ist immer eine echte ' +
    'Buchung — etwas verändert sich am Bestand.\n' +
    '\n' +
    'Anlässe: Wareneingang, Lieferung, Rückgabe, Verbrauch, Baustellenmaterial, das ' +
    'mitgenommen oder verbraucht wird, ein Kollege, der sich was zurücklegt, oder ' +
    'eine Reservierung, die nicht mehr gebraucht wird.\n' +
    '\n' +
    'NICHT hier: eine reine Frage, was im Lager ist (Lagerauskunft), der Wunsch, ' +
    'die ganze Liste als Datei zu bekommen (Lagerliste), eine Bestandskorrektur an ' +
    'einer bereits existierenden Zeile (Lagerpflege), das Aufmaß einer Baustelle, ' +
    'das den Bestand gar nicht anrührt (Materialaufmaß), eine Bestellung beim ' +
    'Großhändler (Bestellung) oder eine allgemeine Frage, etwa nach Preisen ' +
    '(Recherche).',

  implementiert: true,

  // Wird vom Vorgangs-Motor vor jeder Extraktion gerufen.
  kontextFuer: ({ text }) => schreibweisenKontext(text),

  schema: {
    richtung: {
      pflicht: true, typ: 'text', label: 'Vorgang',
      beschreibung: 'genau eines von: einlagern, entnehmen, reservieren, freigeben',
      frage: 'Soll das Material eingelagert, entnommen, reserviert oder freigegeben werden?'
    },
    positionen: {
      pflicht: true, typ: 'liste', min: 1, label: 'Positionen',
      felder: {
        menge: 'zahl', einheit: 'text', bezeichnung: 'text',
        zustand: 'text?', kategorie: 'text?', umgerechnet_aus: 'text?'
      },
      beschreibung: 'eine Zeile je Artikel',
      frage: 'Welches Material und wie viel? (z. B. „5 Stahlbögen DN50")'
    }
  },

  extraktionsHinweise:
    '- richtung ist IMMER genau eines von: einlagern, entnehmen, reservieren, freigeben.\n' +
    '  "hinzufügen"/"dazu"/"Wareneingang"/"zurück" -> einlagern\n' +
    '  "raus"/"entnehmen"/"verbraucht"/"geholt"     -> entnehmen\n' +
    '  "reservieren"/"vormerken"/"zurücklegen"      -> reservieren\n' +
    '  "Reservierung aufheben"/"doch nicht"         -> freigeben\n' +
    '- Mengenmuster: "5 Stahlbögen DN50", "12m Kupferrohr", "3x Fitting".\n' +
    '- Einheiten normalisieren: "Stück"/"stk" -> "Stk.", sonst "m", "lfm", "kg".\n' +
    '- Ohne Mengenangabe: menge 1, einheit "Stk.".\n' +
    '- Maßangaben IMMER in die Bezeichnung übernehmen und normalisieren:\n' +
    '  "DN 50" -> "DN50", "DN-20" -> "DN20"; "20er"/"22er"/"28er" -> "20mm"/"22mm"/"28mm";\n' +
    '  "halbzöllig" -> "1/2 Zoll" oder "DN15", "3/4 zöllig" -> "3/4 Zoll" oder "DN20";\n' +
    '  "1 zöllig" -> "1 Zoll" oder "DN25", "5/4 zöllig" -> "5/4 Zoll" oder "DN32".\n' +
    '  Die Maßeinheit gehört in die bezeichnung, sonst findet findePosition die Zeile nicht.\n' +
    '- zustand ist eines von "neu", "gebraucht", "verschmutzt". Ohne Angabe: "neu".\n' +
    '- kategorie aus dieser festen Liste wählen, sonst "Sonstiges":\n    ' + KATEGORIEN.join(', ') + '\n' +
    '- Diktier- und OCR-Fehler still korrigieren.\n' +
    '- Gebinde selbst umrechnen ("1 Stange" -> 6 m), dabei die Basiseinheit als einheit\n' +
    '  setzen UND die Originalangabe in das Feld umgerechnet_aus schreiben ("1 Stange").\n' +
    '  Nur so sieht der Nutzer in der Bestätigung, ob die Umrechnung stimmt.\n' +
    '  Steht die Gebindegröße nicht im Fachwissen: nicht raten, sondern nachfragen.\n' +
    '- Zur Schreibweise: sagt die Eingabe DASSELBE wie eine bereits vorhandene Zeile,\n' +
    '  nimm deren Schreibweise zeichengenau. Nennt sie etwas ZUSÄTZLICHES, ist es eine\n' +
    '  neue Position. Fehlt der Eingabe etwas, das die vorhandene Zeile nennt: nachfragen.',

  commands: [
    {
      name: 'lager_anlegen',
      beschreibung: 'Legt eine leere Lagerdatei an, falls noch keine existiert',
      ausfuehren: async () => {
        const r = await libExcel.erstelleLeer(PFADE.MATERIAL_XLSX);
        return {
          text: r.erstellt
            ? '📦 Leere Lagerdatei angelegt. Du kannst jetzt Material einlagern.'
            : '📦 Es gibt bereits eine Lagerdatei — sie wird nicht überschrieben.'
        };
      }
    },
    {
      name: 'reservierungen',
      beschreibung: 'Zeigt deine Reservierungen mit Nummer, Zeitpunkt und Status',
      ausfuehren: async ({ chatId }) => {
        const vorgaenge = reservierungen.vonMonteur(chatId);
        const imLager = material.reservierungenVon(await material.leseAlle(PFADE.MATERIAL_XLSX), chatId);

        if (!vorgaenge.length && !imLager.length) {
          return { text: '🔖 Du hast gerade nichts reserviert.' };
        }

        const zeichen = {
          offen: '🟡 wartet auf den Lageristen',
          in_arbeit: '🔵 wird gerade geprüft',
          bereitgestellt: '📦 liegt bereit (ausgebucht)',
          reserviert: '✅ bestätigt, liegt im Regal',
          abgelehnt: '❌ abgelehnt'
        };

        const zeilen = ['🔖 *Deine Reservierungen*', ''];
        for (const v of vorgaenge.slice(0, 15)) {
          const b = reservierungen.bilanz(v);
          zeilen.push(`*${v.id}* · ${lagerNachricht.zeitpunkt(v.erstelltAm)}`);
          zeilen.push(`   ${zeichen[v.status] || v.status}`);
          for (const p of v.positionen) {
            const marke = p.bestaetigt === null ? '·'
              : p.bestaetigt >= p.menge ? '✅' : p.bestaetigt > 0 ? '🟠' : '❌';
            const menge = p.bestaetigt !== null && p.bestaetigt < p.menge
              ? `${p.bestaetigt} statt ${p.menge}` : `${p.menge}`;
            zeilen.push(`   ${marke} ${menge} ${p.einheit}  ${p.bezeichnung}`);
          }
          if (b.fehlendeListe.length && v.status !== 'offen') {
            zeilen.push(`   _${b.fehlendeListe.length} Position(en) fehlen ganz oder teilweise._`);
          }
          zeilen.push('');
        }
        if (vorgaenge.length > 15) zeilen.push(`_… und ${vorgaenge.length - 15} ältere._`);

        // Alte Vormerkungen ohne Vorgangsnummer (aus der Zeit vor den
        // Reservierungsnummern) wuerden sonst spurlos verschwinden.
        const bekannt = new Set(vorgaenge.flatMap((v) => v.positionen.map((p) => p.bezeichnung)));
        const ohneNummer = imLager.filter((r) => !bekannt.has(r.bezeichnung));
        if (ohneNummer.length) {
          zeilen.push('_Ohne Nummer vorgemerkt:_');
          for (const r of ohneNummer) zeilen.push(`   · ${r.menge} ${r.einheit}  ${r.bezeichnung}`);
        }

        return { text: zeilen.join('\n') };
      }
    }
  ],

  async finalisiere({ chatId, daten }, dienste) {
    const richtung = String(daten.richtung || '').toLowerCase().trim();
    if (!RICHTUNGEN[richtung]) {
      return {
        text: `Unklar, was passieren soll ("${daten.richtung}"). ` +
          `Möglich sind: einlagern, entnehmen, reservieren, freigeben.`
      };
    }
    const { positionen, hinweise } = normalisierePositionen(daten.positionen);
    const gefasst = { ...daten, positionen };
    if (hinweise.length) {
      dienste.protokoll?.('Wissen', `Lager ${richtung}: ${hinweise.join(' | ')}`);
    }
    dienste.protokoll?.('Experte', `Lager ${richtung}: ${positionen.length} Position(en) (${chatId})`);

    const ergebnis = richtung === 'einlagern' ? await einlagern(gefasst, chatId)
      : richtung === 'entnehmen' ? await entnehmen(gefasst, chatId)
      : richtung === 'reservieren' ? await reservieren(gefasst, chatId)
      : await freigeben(gefasst, chatId);

    await erneuereSchreibweisenDoku();

    // Umrechnungen offenlegen — der Nutzer soll sehen, was aus seinen Worten wurde.
    if (hinweise.length) {
      ergebnis.text += `\n\n_Umgerechnet: ${hinweise.join('; ')}_`;
    }
    return ergebnis;
  },

  _intern: { einlagern, entnehmen, reservieren, freigeben, normalisierePositionen, RICHTUNGEN }
};
