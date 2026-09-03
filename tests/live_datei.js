// LIVE-TEST: Datei-Erkennung. Nicht Teil von `npm test`.
require('dotenv').config();
const fs = require('fs'), path = require('path');
const { getProvider } = require('../providers');
const router = require('../kern/router');
const p = getProvider('router');
const jsonText = async (s, u, o = {}) => { const a = await p.chat(s, u, o); return (a.content && a.content.trim()) ? a.content : (a.reasoning || ''); };

const SPRACHE = 'Erstelle mir bitte ein Materialaufmaß für 16er Meblerbögen, 10 Stück. ' +
  'Schwarzrohr DN 100, 8 Meter. Schwarzrohr DN 80, 7 Meter. Eine Grundfos Magna 3 Pumpe.';

(async () => {
  console.log('--- 1. Sprachnachricht, KEINE Datei ---');
  let r = await router.entscheide({ text: SPRACHE, chatId: 342450413, chat: jsonText,
    protokoll: (t, m) => console.log('   [' + t + '] ' + m) });
  console.log(`   -> ${r.aktion}/${r.experte || '-'}  conf=${r.confidence}` + (r.hinweis ? `  (${r.hinweis})` : ''));

  const vorlage = fs.existsSync('data/aufnahme_vorlage')
    ? fs.readdirSync('data/aufnahme_vorlage').filter(f => f.endsWith('.pdf'))[0] : null;
  if (!vorlage) { console.log('\n(keine Vorlagen-PDF zum Testen vorhanden)'); return; }
  const pfad = path.join('data/aufnahme_vorlage', vorlage);

  console.log(`\n--- 2. Leeres Formular "${vorlage}" ---`);
  r = await router.entscheide({ text: '', chatId: 342450413, chat: jsonText,
    dokInfo: { name: vorlage, mimeType: 'application/pdf', size: fs.statSync(pfad).size, pfad },
    protokoll: (t, m) => console.log('   [' + t + '] ' + m) });
  console.log(`   -> ${r.aktion}/${r.experte || '-'}  conf=${r.confidence}` + (r.hinweis ? `  (${r.hinweis})` : ''));
})().catch(e => console.error('FEHLER:', e.message));
