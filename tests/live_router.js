// LIVE-TEST gegen die echte KI-API — NICHT Teil von `npm test`.
//
// Aufruf:  node tests/live_router.js
//
// Prüft mit echten Anfragen, ob der Router die typischen Fälle richtig
// zuordnet. Kostet API-Token und braucht die Keys aus der .env. Nach einem
// Modell- oder Anbieterwechsel einmal laufen lassen — Routing-Qualität lässt
// sich nur so beurteilen, die Offline-Tests prüfen nur die Mechanik.
//
// Modell-Antworten schwanken; ein einzelner Ausrutscher ist kein Fehler.
// Alarmierend ist, wenn ein Fall dauerhaft falsch landet oder der Hinweis
// "kein gültiges JSON" erscheint.

require('dotenv').config();
const { getProvider, uebersicht } = require('../providers');
const router = require('../kern/router');
const p = getProvider('router');
console.log('Router:', p.name, '| Budget:', uebersicht().find(r=>r.rolle==='router').maxTokens, 'Token\n');

const jsonText = async (sys, user, opts = {}) => {
  const a = await p.chat(sys, user, opts);
  if (a.content && a.content.trim()) return a.content;
  console.log('   (content leer -> berge aus Reasoning, abgeschnitten:', !!a.abgeschnitten + ')');
  return a.reasoning || '';
};

const faelle = [
  ['Aufmaß per Sprachnachricht', 'Erstelle mir bitte ein Materialaufmaß für 16er Meblerbögen, 10 Stück. Schwarzrohr DN 100, 8 Meter. Schwarzrohr DN 80, 7 Meter.'],
  ['Bestandsfrage',              'was haben wir noch an DN70 im lager?'],
  ['Anleitung (Falle!)',         'ich brauche eine Anleitung für die Grundfos Magna 3'],
  ['Bestellung',                 'bestell mir bitte 20m Kupferrohr 22mm bei der GC für die Baustelle Müller'],
];

(async () => {
  for (const [name, text] of faelle) {
    process.stdout.write(name.padEnd(28));
    const t = Date.now();
    const r = await router.entscheide({ text, chatId: 342450413, chat: jsonText });
    console.log(`-> ${r.aktion}/${r.experte || '-'}  conf=${r.confidence}  thema=${r.thema.id || 'neu'}  (${Date.now()-t}ms)` +
      (r.hinweis ? `\n   Hinweis: ${r.hinweis}` : ''));
  }
})().catch(e => console.error('FEHLER:', e.message));
