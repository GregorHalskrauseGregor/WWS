// LIVE-TEST: Massen-Import einer Excel-Lagerliste gegen die echte KI.
// Nicht Teil von `npm test`. Aufruf: node tests/live_import.js [datei.xlsx]
require('dotenv').config();
const fs = require('fs');
const { getProvider } = require('../providers');
const motor = require('../kern/vorgangsmotor');
const experten = require('../experten');
const { excelZuText } = require('../dokument');

const p = getProvider('extraktion');
const jsonText = async (s, u, o = {}) => {
  const a = await p.chat(s, u, o);
  return (a.content && a.content.trim()) ? a.content : (a.reasoning || '');
};

(async () => {
  const datei = process.argv[2] || '/tmp/gross.xlsx';
  const text = await excelZuText(fs.readFileSync(datei));
  const zeilen = text.split('\n').filter((z) => z.trim()).length;
  console.log(`Datei: ${datei}`);
  console.log(`  ${zeilen} Zeilen, ${text.length} Zeichen (~${Math.round(text.length / 4)} Token)\n`);

  const lager = experten.findeExperteMitId('lager');
  const start = Date.now();
  const r = await motor.extrahiereAusDokument(lager, text, {
    chat: jsonText,
    protokoll: (t, m) => console.log(`  [${t}] ${m}`)
  });
  const dauer = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\nAuszüge: ${r.stuecke} | ohne Ergebnis: ${r.fehler} | erkannt: ${r.ops.length} Positionen | ${dauer}s`);
  const angewandt = motor.wendeOpsAn({}, r.ops, lager.schema);
  console.log(`Übernommen: ${(angewandt.daten.positionen || []).length}, verworfen: ${angewandt.abgelehnt.length}`);
  console.log('\nStichprobe:');
  (angewandt.daten.positionen || []).slice(0, 5).forEach((x, i) =>
    console.log(`  ${i + 1}. ${x.menge} ${x.einheit || ''} ${x.bezeichnung}`));
  const quote = zeilen > 1 ? Math.round(r.ops.length / (zeilen - 2) * 100) : 0;
  console.log(`\nErfassungsquote: ~${quote}% der Artikelzeilen`);
})().catch((e) => console.error('FEHLER:', e.message));
