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
  return { text: `🔖 *Reserviert*\n${zeilen.join('\n')}\n\n_Reserviertes Material ist für andere gesperrt._` };
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
    '  Steht die Gebindegröße nicht im Fachwissen: nicht raten, sondern nachfragen.',

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
      beschreibung: 'Zeigt, was du gerade vorgemerkt hast',
      ausfuehren: async ({ chatId }) => {
        const meine = material.reservierungenVon(await material.leseAlle(PFADE.MATERIAL_XLSX), chatId);
        if (!meine.length) return { text: '🔖 Du hast gerade nichts reserviert.' };
        return {
          text: '🔖 *Deine Reservierungen:*\n' +
            meine.map((r) => zeile(`${r.bezeichnung}: ${r.menge} ${r.einheit}`)).join('\n')
        };
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

    // Umrechnungen offenlegen — der Nutzer soll sehen, was aus seinen Worten wurde.
    if (hinweise.length) {
      ergebnis.text += `\n\n_Umgerechnet: ${hinweise.join('; ')}_`;
    }
    return ergebnis;
  },

  _intern: { einlagern, entnehmen, reservieren, freigeben, normalisierePositionen, RICHTUNGEN }
};
