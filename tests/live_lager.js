// LIVE-TEST: trennt der Router die drei Lager-Experten sauber? Kostet API-Token.
require('dotenv').config();
const { getProvider } = require('../providers');
const router = require('../kern/router');
const p = getProvider('router');
const jsonText = async (s, u, o = {}) => { const a = await p.chat(s, u, o); return (a.content && a.content.trim()) ? a.content : (a.reasoning || ''); };

const faelle = [
  ['einlagern',        'füge 5 Stahl Bögen DN50 dem Lager hinzu',           'lager'],
  ['entnehmen',        'ich hab 3 Kugelhähne DN20 aus dem Lager geholt',     'lager'],
  ['reservieren',      'reservier mir bitte 4 Magna3 Pumpen für nächste Woche', 'lager'],
  ['nur fragen',       'wie viele Stahlbögen DN50 haben wir noch?',          'lagerauskunft'],
  ['Liste als Datei',  'schick mir bitte die Lagerliste als Excel',          'lagerliste'],
  ['Bestand allgemein','gebe mir den aktuellen lagerbestand',                ['lagerliste', 'lagerauskunft']],
  ['Datei einlagern',  'Füge bitte ins lager ein',                           'lager'],
  ['Aufmaß (Falle!)',  'Aufmaß 26-0111 Müller, 12m Kupferrohr verlegt',      'materialaufmass'],
  ['Bestellung',       'bestell 20m Kupferrohr bei der GC',                  'bestellung'],
];

(async () => {
  let treffer = 0;
  for (const [name, text, erwartet] of faelle) {
    const r = await router.entscheide({ text, chatId: 342450413, chat: jsonText });
    const ist = r.aktion === 'verarbeiten' ? r.experte : r.aktion;
    const erlaubt = Array.isArray(erwartet) ? erwartet : [erwartet];
    const gut = erlaubt.includes(ist);
    if (gut) treffer++;
    console.log(`${gut ? '✅' : '❌'} ${name.padEnd(18)} -> ${String(ist).padEnd(16)} (erwartet ${erlaubt.join(' oder ')})`);
  }
  console.log(`\n${treffer}/${faelle.length} richtig zugeordnet`);
})().catch(e => console.error('FEHLER:', e.message));
