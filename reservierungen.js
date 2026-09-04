// Reservierungen als eigene Vorgaenge — mit Nummer, Zeitpunkt und Status.
//
// Bisher lebte eine Reservierung nur als Eintrag "chatId:menge" in einer Spalte
// der Lagerdatei. Das reicht, um Material zu sperren, aber nicht, um darueber zu
// SPRECHEN: es gibt keinen Zeitpunkt, keinen Status, keine Nummer, auf die sich
// zwei Leute beziehen koennen. Genau das braucht der Ablauf zwischen Monteur und
// Lagerist.
//
// Ablage: data/reservierungen/<id>.json, dazu ein Index fuer die Listen.
// Bewusst eine Datei je Reservierung — sie werden einzeln bearbeitet, und ein
// abgebrochener Schreibvorgang soll nie die ganze Liste zerlegen.
//
// DIE NUMMER ist zugleich ein Telegram-Befehl (/r7k3m9x2). Deshalb nur
// Kleinbuchstaben und Ziffern: Telegram erlaubt in Befehlen nichts anderes, und
// eine Nummer, die man nicht antippen kann, wird abgetippt und dabei vertippt.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('./config');

const STATUS = {
  offen: 'offen',                 // beim Lageristen eingegangen, noch nicht angefasst
  in_arbeit: 'in_arbeit',         // Lagerist geht sie gerade Position fuer Position durch
  bereitgestellt: 'bereitgestellt', // zurechtgemacht, Material gilt als entnommen
  reserviert: 'reserviert',       // bestaetigt, liegt aber noch im Regal
  abgelehnt: 'abgelehnt',         // nichts davon war da
  storniert: 'storniert'          // vom Monteur zurueckgezogen, bevor der Lagerist fertig war
};

// Bis wohin der Monteur zurueckziehen darf. Danach hat der Lagerist das
// Material in der Hand — ab da muss der Monteur nehmen, was herausgelegt wurde,
// und es notfalls selbst zurueckraeumen.
const STORNIERBAR = new Set([STATUS.offen, STATUS.in_arbeit]);

// Ohne o/0 und l/1: die Nummer wird vorgelesen und abgetippt.
const ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789';

function neueId() {
  let id = 'r';
  for (let i = 0; i < 8; i++) id += ZEICHEN[Math.floor(Math.random() * ZEICHEN.length)];
  return fs.existsSync(PFADE.RESERVIERUNG(id)) ? neueId() : id;
}

function ordner() {
  fs.mkdirSync(PFADE.RESERVIERUNGEN, { recursive: true });
  return PFADE.RESERVIERUNGEN;
}

function schreibe(r) {
  ordner();
  fs.writeFileSync(PFADE.RESERVIERUNG(r.id), JSON.stringify(r, null, 2), 'utf-8');
  return r;
}

function lade(id) {
  try { return JSON.parse(fs.readFileSync(PFADE.RESERVIERUNG(id), 'utf-8')); }
  catch { return null; }
}

function alle() {
  try {
    return fs.readdirSync(ordner())
      .filter((d) => d.endsWith('.json'))
      .map((d) => lade(d.replace(/\.json$/, '')))
      .filter(Boolean)
      .sort((a, b) => String(b.erstelltAm).localeCompare(String(a.erstelltAm)));
  } catch { return []; }
}

// Was der Lagerist noch vor sich hat.
function offene() {
  return alle().filter((r) => r.status === STATUS.offen || r.status === STATUS.in_arbeit)
    .sort((a, b) => String(a.erstelltAm).localeCompare(String(b.erstelltAm))); // aelteste zuerst
}

function vonMonteur(chatId) {
  return alle().filter((r) => String(r.monteurChatId) === String(chatId));
}

// positionen: [{ bezeichnung, menge, einheit }]
function anlegen({ monteurChatId, monteurName, positionen, bemerkung }) {
  const r = {
    id: neueId(),
    monteurChatId: String(monteurChatId),
    monteurName: monteurName || null,
    erstelltAm: new Date().toISOString(),
    status: STATUS.offen,
    bemerkung: bemerkung || null,
    // bestaetigt: null = noch nicht angesehen, sonst die Menge, die der
    // Lagerist tatsaechlich gefunden hat (0 = nicht da).
    positionen: (positionen || []).map((p) => ({
      bezeichnung: p.bezeichnung,
      menge: p.menge,
      einheit: p.einheit || 'Stk.',
      bestaetigt: null,
      // Hat der Lagerist bestaetigt, dass eine kleinere Menge den Rest bedeutet?
      // Ohne diese Bestaetigung wird der Bestand NICHT angefasst.
      restBestaetigt: false
    })),
    bearbeitetVon: null,
    bearbeitetAm: null
  };
  return schreibe(r);
}

function setzeStatus(id, status, zusatz = {}) {
  const r = lade(id);
  if (!r) return null;
  r.status = status;
  Object.assign(r, zusatz);
  return schreibe(r);
}

function setzeBestaetigung(id, index, menge, restBestaetigt = false) {
  const r = lade(id);
  if (!r || !r.positionen[index]) return null;
  r.positionen[index].bestaetigt = Math.max(0, Number(menge) || 0);
  r.positionen[index].restBestaetigt = !!restBestaetigt;
  return schreibe(r);
}

// Zurueckziehen durch den Monteur.
async function storniere(id, { chatId, material, pfad }) {
  const r = lade(id);
  if (!r) return { erfolg: false, grund: 'unbekannt' };
  if (String(r.monteurChatId) !== String(chatId)) {
    return { erfolg: false, grund: 'fremd', reservierung: r };
  }
  if (!STORNIERBAR.has(r.status)) {
    return { erfolg: false, grund: 'zu_spaet', reservierung: r };
  }

  // Die volle urspruengliche Menge freigeben — der Lagerist hat noch nichts
  // gebucht, also steht im Lager noch die Vormerkung von der Bestellung.
  const freizugeben = r.positionen.map((p) => ({ bezeichnung: p.bezeichnung, menge: p.menge }));
  if (freizugeben.length) await material.gibReservierungFrei(freizugeben, pfad, r.monteurChatId);

  setzeStatus(id, STATUS.storniert, { storniertAm: new Date().toISOString() });
  return {
    erfolg: true,
    reservierung: lade(id),
    // Wenn der Lagerist gerade daran arbeitet, muss er es sofort erfahren —
    // sonst legt er Material fuer einen Auftrag zusammen, den es nicht mehr gibt.
    unterbrichtLageristen: r.status === STATUS.in_arbeit ? r.bearbeitetVon : null
  };
}

// Wie ist die Reservierung ausgegangen? Braucht der Monteur, und die Antwort
// steht nirgends explizit — sie ergibt sich aus den Positionen.
function bilanz(r) {
  const pos = r.positionen || [];
  const angesehen = pos.filter((p) => p.bestaetigt !== null);
  const voll = angesehen.filter((p) => p.bestaetigt >= p.menge);
  const teil = angesehen.filter((p) => p.bestaetigt > 0 && p.bestaetigt < p.menge);
  const keins = angesehen.filter((p) => p.bestaetigt === 0);
  return {
    gesamt: pos.length,
    angesehen: angesehen.length,
    vollstaendig: voll.length,
    teilweise: teil.length,
    fehlend: keins.length,
    allesDa: angesehen.length === pos.length && voll.length === pos.length,
    nichtsDa: angesehen.length === pos.length && keins.length === pos.length,
    fehlendeListe: [...teil, ...keins]
  };
}

// Der Abschluss — die einzige Stelle, an der eine Reservierung Bestand bewegt.
//
// Stand vorher im Lager-Bot-Adapter. Dort war sie falsch aufgehoben: ein Adapter
// soll Nachrichten uebersetzen, nicht buchen. Hier ist sie testbar, ohne dass
// ein Telegram-Bot laufen muss — und ein zweiter Kanal (Web, Tablet im Lager)
// bekaeme dieselbe Logik, statt sie nachzubauen.
//
// REIHENFOLGE IST HIER ENTSCHEIDEND:
//   1. Bestand auf die gezaehlte Menge korrigieren
//   2. erst dann ausbuchen
// Andersherum wuerde von einer Zahl abgezogen, von der man gerade festgestellt
// hat, dass sie falsch ist.
async function abschliessen(id, { zurechtgelegt, material, pfad }) {
  const r = lade(id);
  if (!r) return null;

  const korrekturen = [];
  const bestand = await material.leseAlle(pfad);

  for (const p of r.positionen) {
    if (p.bestaetigt === null || p.bestaetigt >= p.menge) continue;
    // OHNE ausdrueckliche Bestaetigung wird kein Bestand angefasst. Der Lagerist
    // stellt zusammen, er entscheidet nicht, ob dem Monteur 5 statt 12 reichen.
    // Gibt er weniger mit, heisst das: mehr war nicht da — und genau das muss er
    // im Workflow bestaetigt haben, sonst bleibt die Zahl in der Liste stehen.
    if (!p.restBestaetigt) continue;
    const zeile = material.findePosition(bestand, p.bezeichnung);
    if (!zeile) continue;
    const gelistet = material.gesamtbestand(zeile);
    // Nur nach unten: ein gemeldeter Fehlbestand wird uebernommen, ein
    // Ueberbestand nie.
    if (p.bestaetigt < gelistet) {
      korrekturen.push({
        bezeichnung: p.bezeichnung, wert: p.bestaetigt, zustand: 'neu',
        meldung: `${p.bezeichnung}: Bestand ${gelistet} → ${p.bestaetigt}`
      });
    }
  }
  if (korrekturen.length) await material.setzeBestand(korrekturen, pfad);

  const bestaetigte = r.positionen
    .filter((p) => p.bestaetigt > 0)
    .map((p) => ({ bezeichnung: p.bezeichnung, menge: p.bestaetigt, einheit: p.einheit }));

  if (zurechtgelegt && bestaetigte.length) {
    // Zurechtgelegt heisst: liegt nicht mehr im Regal. Die eigene Vormerkung
    // wird beim Entnehmen aufgezehrt, sonst bliebe Material gesperrt, das
    // laengst auf dem Kommissionierplatz steht.
    await material.entnehmePositionen(bestaetigte, pfad, r.monteurChatId);
    setzeStatus(id, STATUS.bereitgestellt, { bearbeitetAm: new Date().toISOString() });
  } else {
    // Was nicht da war, darf nicht weiter vorgemerkt bleiben — sonst sperrt
    // eine Reservierung Material, das es gar nicht gibt.
    const zuViel = r.positionen
      .filter((p) => p.bestaetigt !== null && p.bestaetigt < p.menge)
      .map((p) => ({ bezeichnung: p.bezeichnung, menge: p.menge - p.bestaetigt }));
    if (zuViel.length) await material.gibReservierungFrei(zuViel, pfad, r.monteurChatId);

    const b = bilanz(r);
    setzeStatus(id, b.nichtsDa ? STATUS.abgelehnt : STATUS.reserviert,
      { bearbeitetAm: new Date().toISOString() });
  }

  const fertig = lade(id);
  return {
    reservierung: fertig,
    bilanz: bilanz(fertig),
    korrekturen: korrekturen.map((k) => k.meldung)
  };
}

module.exports = {
  STATUS, STORNIERBAR, neueId, anlegen, lade, alle, offene, vonMonteur,
  setzeStatus, setzeBestaetigung, bilanz, schreibe, abschliessen, storniere
};
