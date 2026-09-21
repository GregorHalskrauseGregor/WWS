// /einstellungen — der Einstellungsbereich.
//
// Zwei Ebenen: /einstellungen zeigt, was jeder über sich selbst sehen darf.
// /einstellungen <Kennwort> öffnet zusätzlich den Admin-Bereich, in dem Rollen
// vergeben und die Wartungsbefehle erreichbar sind. Das Kennwort steht in der
// .env (ADMIN_KENNWORT) und nirgends im Code; ohne gesetztes Kennwort gibt es
// keinen Admin-Zugang — ein leeres Kennwort wäre ein offenes.
//
// SOLANGE DIE EINSTELLUNGEN OFFEN SIND, RUHT DER REST DES BOTS. Das ist keine
// Bequemlichkeit: eine Nachricht, die während einer laufenden Rollenänderung
// verarbeitet wird, sieht je nach Zeitpunkt die alte oder die neue Rolle.
// Lieber eine Sekunde blockieren als ein Ergebnis, das von der Reihenfolge
// abhängt.
//
// Änderungen werden GESAMMELT und erst bei /verlassen geschrieben. Wer sich
// vertippt, tippt die richtige Rolle hinterher — solange nicht gespeichert ist,
// ist nichts passiert.

const rollen = require('./rollen');
const gruppen = require('./gruppen');

const BEFEHLE_ROLLE = {
  zulagerist: 'lagerist',
  zumonteur: 'monteur',
  zuprojektleiter: 'projektleiter',
  zuprojektassistenz: 'projektassistenz'
};

// Wartungsbefehle, die NUR hier drin funktionieren. Der Adapter führt sie aus;
// diese Liste sagt ihm, welche er im Admin-Bereich durchlassen darf.
const ADMIN_BEFEHLE = ['protokoll', 'dienste', 'komprimieren',
  'lager_anlegen', 'grosshandel_status', 'aufmass_reset'];

function kennwortStimmt(eingabe) {
  const soll = process.env.ADMIN_KENNWORT;
  if (!soll) return false;
  return String(eingabe || '').trim() === soll;
}

function menue(chatId, { admin, geplanteRolle }) {
  const jetzt = rollen.rolleVon(chatId);
  const zeilen = [
    '⚙️ *Einstellungen*',
    '',
    '_Der Rest des Bots ist angehalten, solange das hier offen ist._',
    '',
    '*Deine Rolle*',
    rollen.beschreibe(geplanteRolle || jetzt) +
      (geplanteRolle && geplanteRolle !== jetzt ? '\n⚠️ _geändert, noch nicht gespeichert_' : ''),
    ''
  ];

  // Gruppen sind nutzereigen: hier steht nur, was DIESEM Konto gehoert.
  // Hinzufuegen kann der Bot sich nicht selbst — das laesst Telegram nicht zu.
  // Also steht hier die Anleitung statt eines Knopfes, der nichts tun koennte.
  const meineGruppen = gruppen.fuerBesitzer(chatId);
  zeilen.push('*Deine Gruppen*');
  if (meineGruppen.length) {
    for (const g of meineGruppen.slice(0, 15)) {
      zeilen.push(`• ${g.titel || g.gruppenId}`);
    }
    zeilen.push('', '_Was dort entsteht, liegt in deiner Ablage._');
  } else {
    zeilen.push('_noch keine_');
  }
  zeilen.push('',
    'Neue Gruppe: öffne sie in Telegram, tipp auf den Gruppennamen,',
    '*Mitglieder hinzufügen* — und füg mich hinzu.',
    '_Wer mich hinzufügt, dem gehört die Gruppe._',
    '', '/gruppen — Übersicht auch außerhalb der Einstellungen', '');

  if (admin) {
    zeilen.push('🔓 *Admin*', '', '*Rolle zuweisen*');
    for (const [befehl, rolle] of Object.entries(BEFEHLE_ROLLE)) {
      const r = rollen.ROLLEN[rolle];
      zeilen.push(`/${anzeige(befehl)} — ${r.emoji} ${r.name}`);
    }
    zeilen.push('', '*Wartung*');
    zeilen.push('/protokoll — die letzten Systemmeldungen');
    zeilen.push('/dienste — welche KI-Anbieter und Fach-APIs laufen');
    zeilen.push('/komprimieren — Verlauf und Gedächtnis verdichten');
    zeilen.push('/lager\\_anlegen — leere Lagerdatei anlegen');
    zeilen.push('/aufmass\\_reset — alle offenen Aufmaße verwerfen');
    zeilen.push('');
  } else {
    zeilen.push('_Zum Ändern brauchst du den Admin-Zugang:_',
      '`/einstellungen <Kennwort>`', '');
  }

  zeilen.push('─────────────', '');
  zeilen.push('/verlassen — speichern und schließen');
  zeilen.push('/reset — alles auf Standard zurücksetzen _(noch ohne Funktion)_');
  return zeilen.join('\n');
}

// zulagerist -> zuLagerist. Nur für die Anzeige: Telegram-Befehle sind
// unabhängig von Groß- und Kleinschreibung, gelesen wird kleingeschrieben.
function anzeige(klein) {
  return klein.replace(/^zu(.)/, (_, c) => 'zu' + c.toUpperCase());
}

function oeffne(chatId, argument) {
  const admin = kennwortStimmt(argument);
  const falsch = argument && !admin;
  const daten = { admin, geplanteRolle: null };
  let text = menue(chatId, daten);
  if (falsch) {
    text = '🔒 Kennwort stimmt nicht. Die Einstellungen sind offen, aber ohne Admin-Rechte.\n\n' + text;
  }
  return { daten, text };
}

// Jede Nachricht, solange der Modus läuft.
// Rückgabe: { text, daten?, beenden?, durchlassen? }
//   durchlassen: der Adapter soll den Befehl normal ausführen (Wartung im Admin).
function verarbeite(chatId, text, daten) {
  const roh = String(text || '').trim();
  const befehl = roh.replace(/^\//, '').split(/\s+/)[0].toLowerCase();
  const rest = roh.replace(/^\S+\s*/, '').trim();

  // Raus. Bewusst großzügig: ein Einstellungsbereich, aus dem man nicht
  // herauskommt, sperrt beim ersten Vertipper den ganzen Bot.
  if (/^(verlassen|fertig|ende|schliessen|schließen|abbrechen|exit|quit|zurueck|zurück)$/i.test(befehl)
      || (befehl === 'einstellungen' && /^(end|ende|verlassen|fertig)$/i.test(rest))) {
    return schliesse(chatId, daten);
  }

  if (befehl === 'reset') {
    return {
      text: '↩️ *Zurücksetzen*\n\nGibt es noch nicht. Später stellt das hier alle ' +
        'Einstellungen auf den Auslieferungszustand zurück — Rolle, Vorgaben, Vorlagen.\n\n' +
        '_Deine Rolle ändert sich dadurch gerade nicht._'
    };
  }

  if (BEFEHLE_ROLLE[befehl]) {
    if (!daten.admin) {
      return { text: '🔒 Rollen vergibt nur der Admin.\n\n`/einstellungen <Kennwort>`' };
    }
    const rolle = BEFEHLE_ROLLE[befehl];
    const neu = { ...daten, geplanteRolle: rolle };
    return {
      daten: neu,
      text: `Vorgemerkt: ${rollen.beschreibe(rolle)}\n\n` +
        '_Noch nicht gespeichert — /verlassen schreibt es fest._\n\n' + menue(chatId, neu)
    };
  }

  // Wartungsbefehle: im Admin-Bereich normal ausführen, sonst abweisen.
  if (ADMIN_BEFEHLE.includes(befehl)) {
    if (!daten.admin) {
      return { text: `🔒 \`/${befehl}\` ist ein Wartungsbefehl.\n\n\`/einstellungen <Kennwort>\`` };
    }
    return { durchlassen: true };
  }

  if (befehl === 'einstellungen' || befehl === 'options') {
    if (rest && kennwortStimmt(rest)) {
      const neu = { ...daten, admin: true };
      return { daten: neu, text: '🔓 Admin-Zugang entsperrt.\n\n' + menue(chatId, neu) };
    }
    return { text: menue(chatId, daten) };
  }

  return { text: 'Das gehört nicht in die Einstellungen.\n\n' + menue(chatId, daten) };
}

function schliesse(chatId, daten) {
  const zeilen = [];
  if (daten.geplanteRolle && rollen.setzeRolle(chatId, daten.geplanteRolle)) {
    zeilen.push(`✅ Gespeichert: ${rollen.beschreibe(daten.geplanteRolle)}`);
  } else {
    zeilen.push('✅ Einstellungen geschlossen, nichts geändert.');
  }
  zeilen.push('', 'Der Bot ist wieder normal ansprechbar.');
  return { text: zeilen.join('\n'), beenden: true };
}

module.exports = { oeffne, verarbeite, kennwortStimmt, BEFEHLE_ROLLE, ADMIN_BEFEHLE };
