// /start und /befehle — die beiden Texte, die erklären, was DILA ist.
//
// Erzeugt statt geschrieben: die Expertenliste kommt aus den geladenen Modulen,
// nicht aus einer gepflegten Aufzählung. Eine Liste von Hand ist beim dritten
// neuen Experten falsch, und niemand merkt es — die Datei, die niemand liest,
// ist genau die, die neue Leute zuerst lesen.
//
// Die Befehlsliste ist hier als DATEN abgelegt statt als Fließtext. Ein Test
// hält sie gegen das ab, was der Adapter wirklich registriert: ein Befehl ohne
// Eintrag und ein Eintrag ohne Befehl fallen beide auf.

const experten = require('./experten');
const rollen = require('./rollen');

// Die fest verdrahteten Befehle des Hauptbots. Was die Experten mitbringen,
// kommt aus experten.alleCommands() dazu.
const KERNBEFEHLE = [
  { name: 'start', gruppe: 'Einstieg', beschreibung: 'Was DILA kann und wie man anfängt' },
  { name: 'befehle', gruppe: 'Einstieg', beschreibung: 'Diese Liste' },
  { name: 'einstellungen', gruppe: 'Einstieg', beschreibung: 'Rolle und Einstellungen — hält den Rest des Bots so lange an' },

  { name: 'themen', gruppe: 'Gesprächsfäden', beschreibung: 'Alle laufenden Fäden mit offenen Vorgängen' },
  { name: 'zusammenfassung', gruppe: 'Gesprächsfäden', beschreibung: 'Kurzfassung eines Fadens', argument: '<Name>' },
  { name: 'loeschen', gruppe: 'Gesprächsfäden', beschreibung: 'Faden samt Verlauf löschen', argument: '<Name>' },

  { name: 'gedaechtnis', gruppe: 'Gedächtnis', beschreibung: 'Was sich DILA dauerhaft über dich gemerkt hat' },
  { name: 'vergiss', gruppe: 'Gedächtnis', beschreibung: 'Einen gemerkten Punkt streichen', argument: '<Nummer>' },

  { name: 'wer_bin_ich', gruppe: 'Konto', beschreibung: 'Dein Profil und deine Chat-ID' },
  { name: 'delete_my_data', gruppe: 'Konto', beschreibung: 'Alle deine Daten löschen' },

  { name: 'protokoll', gruppe: 'Wartung', beschreibung: 'Die letzten Systemmeldungen', nurAdmin: true },
  { name: 'dienste', gruppe: 'Wartung', beschreibung: 'Welche KI-Anbieter und Fach-APIs gerade laufen', nurAdmin: true },
  { name: 'komprimieren', gruppe: 'Wartung', beschreibung: 'Verlauf und Gedächtnis von Hand verdichten', nurAdmin: true }
];

const GRUPPEN_REIHENFOLGE = ['Einstieg', 'Lager', 'Bestellung', 'Aufmaß', 'Wissen',
  'Gesprächsfäden', 'Gedächtnis', 'Konto', 'Sonstiges', 'Wartung'];

// Unbekannte Gruppen ans Ende statt an eine zufällige Stelle.
function gruppenRang(g) {
  const i = GRUPPEN_REIHENFOLGE.indexOf(g);
  return i === -1 ? GRUPPEN_REIHENFOLGE.length : i;
}

// Ordnet die Befehle der Experten einer Gruppe zu. Steht bewusst hier und nicht
// am Experten: die Gruppierung ist eine Frage der Darstellung, und ein Experte
// soll nichts darüber wissen müssen, wie eine Hilfeseite aufgebaut ist.
const EXPERTEN_GRUPPE = {
  lager: 'Lager', lagerliste: 'Lager', lagerpflege: 'Lager', lagerauskunft: 'Lager',
  bestellung: 'Bestellung', grosshandel: 'Bestellung',
  materialaufmass: 'Aufmaß',
  wissenspflege: 'Wissen'
};

// Befehle von Experten, die Einrichtung oder Diagnose sind und deshalb in den
// Admin-Bereich gehören statt in die Liste für alle. Steht hier und nicht am
// Experten, damit die Fachmodule nichts über Rollen wissen müssen.
const NUR_ADMIN = new Set(['lager_anlegen', 'grosshandel_status', 'aufmass_reset']);

function alleBefehle() {
  const aus = KERNBEFEHLE.map((b) => ({ ...b, quelle: 'kern' }));
  for (const c of experten.alleCommands()) {
    aus.push({
      name: c.name,
      beschreibung: c.beschreibung || '',
      gruppe: EXPERTEN_GRUPPE[c.experte.id] || 'Sonstiges',
      nurAdmin: !!c.nurAdmin || NUR_ADMIN.has(c.name),
      quelle: c.experte.id
    });
  }
  return aus;
}

// ─────────────────────────────────────────────────────────────── /start

function startText(chatId) {
  const liste = experten.listeStatus().filter((e) => e.implementiert);
  const rolle = chatId ? rollen.rolleVon(chatId) : null;

  const zeilen = [
    '🔧 *DILA — Digitaler Lagerist*',
    '',
    'Schreib einfach, wie du reden würdest. DILA versteht, worum es geht, und ' +
    'schickt es an den passenden Fachbereich. Du musst dich an keine Reihenfolge ' +
    'halten und nichts vollständig angeben — was fehlt, wird nachgefragt.',
    ''
  ];

  if (rolle) zeilen.push(`Du bist eingetragen als ${rollen.beschreibe(rolle)}`, '');

  zeilen.push('*Die Fachbereiche*', '');
  const sortiert = [...liste].sort((a, b) =>
    gruppenRang(EXPERTEN_GRUPPE[a.id] || 'Sonstiges') - gruppenRang(EXPERTEN_GRUPPE[b.id] || 'Sonstiges'));
  for (const e of sortiert) {
    zeilen.push(`${e.emoji} *${e.name}* — ${kurz(e.beschreibung)}`);
  }

  zeilen.push(
    '',
    '*Was du schicken kannst*',
    '',
    '🎙 *Sprachnachrichten* — werden abgetippt und ganz normal verarbeitet. ' +
    'Der übliche Weg auf der Baustelle.',
    '📄 *PDF, Excel, Word* — Lieferscheine, Bestandslisten, Aufmaße. DILA liest sie aus ' +
    'und übernimmt die Positionen.',
    '📷 *Fotos und Screenshots* — werden per Texterkennung gelesen. Auch die Unterschrift ' +
    'fürs Aufmaß kommt als Foto.',
    '🔗 *Links* — werden geöffnet und ausgewertet.',
    '💬 *Text* — unsortiert, unvollständig, mitten im Satz abgebrochen. Geht alles.',
    '',
    '─────────────',
    '',
    '📋 /befehle — alle Befehle im Überblick',
    '⚙️ /einstellungen — Rolle und Einstellungen'
  );
  return zeilen.join('\n');
}

// Erster Satz der Beschreibung, damit /start nicht zur Textwand wird. Gekürzt
// wird an einer Wortgrenze — ein abgeschnittenes Wort sieht nach Fehler aus,
// nicht nach Absicht.
const MAX_KURZ = 105;
function kurz(text) {
  const t = String(text || '').trim();
  const punkt = t.indexOf('. ');
  let eins = punkt > 0 ? t.slice(0, punkt) : t.replace(/\.$/, '');
  if (eins.length > MAX_KURZ) {
    const schnitt = eins.lastIndexOf(' ', MAX_KURZ);
    eins = eins.slice(0, schnitt > 40 ? schnitt : MAX_KURZ).trimEnd() + ' …';
  }
  return eins;
}

// ────────────────────────────────────────────────────────────── /befehle

function befehleText(chatId) {
  const istAdmin = false; // Wartungsbefehle stehen im Admin-Bereich, nicht hier.
  const befehle = alleBefehle().filter((b) => !b.nurAdmin || istAdmin);

  const nachGruppe = new Map();
  for (const b of befehle) {
    if (!nachGruppe.has(b.gruppe)) nachGruppe.set(b.gruppe, []);
    nachGruppe.get(b.gruppe).push(b);
  }

  const zeilen = ['📋 *Befehle*', ''];
  const gruppen = [...nachGruppe.keys()].sort((a, b) => gruppenRang(a) - gruppenRang(b));

  for (const g of gruppen) {
    zeilen.push(`*${g}*`);
    for (const b of nachGruppe.get(g)) {
      const ruf = '/' + b.name + (b.argument ? ' ' + b.argument : '');
      zeilen.push(`\`${ruf}\``);
      if (b.beschreibung) zeilen.push(`   ${b.beschreibung}`);
    }
    zeilen.push('');
  }

  zeilen.push('─────────────', '');
  zeilen.push('_Fast alles geht auch ohne Befehl: sag einfach, was du brauchst._');
  zeilen.push('_Einstellungen und Wartung liegen unter /einstellungen._');
  return zeilen.join('\n');
}

module.exports = { KERNBEFEHLE, alleBefehle, startText, befehleText, GRUPPEN_REIHENFOLGE };
