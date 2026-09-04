// Wie der Lagerist die offenen Reservierungen zu sehen bekommt.
//
// Die Nachricht hat eine Aufgabe: dass keine Reservierung untergeht. Alles
// andere ist ihr untergeordnet. Daraus folgen vier Entscheidungen:
//
// 1. ES GIBT IMMER NUR EINE. Kommt eine neue Reservierung dazu, wird die alte
//    Nachricht geloescht und eine neue geschickt. Damit steht die Liste immer
//    ganz unten im Chat und ist nie zwischen anderen Nachrichten begraben.
//    Eine bearbeitete Reservierung verschwindet daraus — was noch dasteht, ist
//    offen. Das ist der ganze Trick: die Liste IST die Aufgabenliste.
//
// 2. DIE NUMMER IST DER BEFEHL. /r7k3m9x2 ist antippbar. Kein Abtippen, kein
//    Vertippen, und in jeder Antwort steht, um welche Reservierung es geht.
//
// 3. DAS ALTER STEHT DABEI, nicht die Uhrzeit. "vor 40 Min." sagt einem
//    Lageristen mehr als "14:12" — er will wissen, wie lange jemand wartet.
//    Ab zwei Stunden wird die Zeile markiert.
//
// 4. KEINE KNOEPFE AN DER LISTE. Knoepfe an einer Nachricht, die staendig neu
//    geschickt wird, zeigen ins Leere, sobald die alte Nachricht weg ist. Der
//    Befehl in der Zeile funktioniert dagegen immer.

const MAHNUNG_AB_MINUTEN = 120;

function alterInMinuten(iso) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function alterText(iso) {
  const m = alterInMinuten(iso);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const t = Math.floor(h / 24);
  return `vor ${t} Tag${t === 1 ? '' : 'en'}`;
}

function zeitpunkt(iso) {
  const d = new Date(iso);
  const zwei = (n) => String(n).padStart(2, '0');
  return `${zwei(d.getDate())}.${zwei(d.getMonth() + 1)}. ${zwei(d.getHours())}:${zwei(d.getMinutes())}`;
}

// Die Liste der offenen Reservierungen.
function offeneListe(reservierungen) {
  if (!reservierungen.length) {
    return '📦 *Lager — alles abgearbeitet*\n\nKeine offenen Reservierungen.';
  }

  const zeilen = [
    `📦 *Offene Reservierungen — ${reservierungen.length}*`,
    `_Stand ${zeitpunkt(new Date().toISOString())}_`,
    ''
  ];

  for (const r of reservierungen) {
    const alt = alterInMinuten(r.erstelltAm) >= MAHNUNG_AB_MINUTEN;
    const anzahl = r.positionen.length;
    zeilen.push(
      `${alt ? '🔴' : '🟡'} *${r.monteurName || 'Monteur'}* · ${alterText(r.erstelltAm)}` +
      (alt ? '  ⚠️' : '')
    );
    // Hoechstens drei Positionen im Ueberblick — die Liste soll auf einen Blick
    // lesbar bleiben, die vollstaendige Aufstellung kommt im Workflow.
    for (const p of r.positionen.slice(0, 3)) {
      zeilen.push(`     ${p.menge} ${p.einheit}  ${p.bezeichnung}`);
    }
    if (anzahl > 3) zeilen.push(`     _… und ${anzahl - 3} weitere_`);
    if (r.bemerkung) zeilen.push(`     💬 _${r.bemerkung}_`);
    zeilen.push(`     ▸ /${r.id}`);
    zeilen.push('');
  }

  zeilen.push('_Tipp auf eine Nummer, um sie durchzugehen._');
  return zeilen.join('\n');
}

// Eine Position im Workflow. Genau eine Frage auf dem Bildschirm — der Lagerist
// steht im Regal und liest auf einem Handy, das er in einer Hand haelt.
function positionsFrage(r, index) {
  const p = r.positionen[index];
  const zeilen = [
    `📦 *${index + 1} von ${r.positionen.length}*  ·  ${r.monteurName || 'Monteur'}`,
    '',
    `*${p.bezeichnung}*`,
    `Gebraucht: *${p.menge} ${p.einheit}*`,
    ''
  ];
  const schon = r.positionen.filter((x) => x.bestaetigt !== null).length;
  if (schon) zeilen.push(`_${schon} von ${r.positionen.length} erledigt._`);
  zeilen.push('_Antworte mit einer Zahl, wenn es nur ein Teil ist._');
  return zeilen.join('\n');
}

// Abschluss: was hat der Lagerist gefunden, und was passiert damit.
function abschlussFrage(r) {
  const zeilen = ['📦 *Durchgegangen* — das kam heraus:', ''];
  for (const p of r.positionen) {
    const b = p.bestaetigt;
    const zeichen = b >= p.menge ? '✅' : b > 0 ? '🟠' : '❌';
    const menge = b >= p.menge ? `${p.menge} ${p.einheit}`
      : b > 0 ? `nur ${b} von ${p.menge} ${p.einheit}`
      : 'nicht da';
    zeilen.push(`${zeichen} ${p.bezeichnung} — ${menge}`);
  }
  zeilen.push('', '*Hast du das Material zurechtgelegt?*', '',
    'Wenn ja, buche ich es sofort aus dem Bestand aus.',
    'Wenn nein, bleibt es reserviert und der Monteur holt es selbst.');
  return zeilen.join('\n');
}

// Was der Monteur nach der Bearbeitung bekommt.
function monteurBescheid(r, bilanz) {
  const kopf = bilanz.nichtsDa ? '❌ *Reservierung abgelehnt*'
    : bilanz.allesDa ? '✅ *Reservierung bestätigt*'
    : '🟠 *Reservierung teilweise bestätigt*';

  const zeilen = [kopf, `_${r.id} · ${zeitpunkt(r.erstelltAm)}_`, ''];

  for (const p of r.positionen) {
    const b = p.bestaetigt === null ? null : p.bestaetigt;
    if (b === null) { zeilen.push(`⏳ ${p.bezeichnung} — noch offen`); continue; }
    if (b >= p.menge) zeilen.push(`✅ ${p.menge} ${p.einheit}  ${p.bezeichnung}`);
    else if (b > 0) zeilen.push(`🟠 ${b} statt ${p.menge} ${p.einheit}  ${p.bezeichnung}`);
    else zeilen.push(`❌ ${p.bezeichnung} — nicht da`);
  }

  zeilen.push('');
  if (r.status === 'bereitgestellt') {
    zeilen.push('📦 *Liegt für dich bereit* und ist aus dem Bestand ausgebucht.');
  } else if (r.status === 'abgelehnt') {
    zeilen.push('Die Reservierung ist aufgehoben. Nichts davon ist gesperrt.');
  } else {
    zeilen.push('🔖 *Bleibt für dich reserviert* — du holst es selbst aus dem Lager.');
  }

  if (bilanz.fehlendeListe.length && !bilanz.nichtsDa) {
    zeilen.push('', '_Was fehlt, musst du bestellen oder anders lösen._');
  }
  zeilen.push('', '_Alle deine Reservierungen: /reservierungen_');
  return zeilen.join('\n');
}

module.exports = {
  offeneListe, positionsFrage, abschlussFrage, monteurBescheid,
  alterText, zeitpunkt, MAHNUNG_AB_MINUTEN
};
