require('dotenv').config();
const { getProvider } = require('../providers');
const router = require('../kern/router');
const experten = require('../experten');
const p = getProvider('router');
let letzterRoh = '';
const jsonText = async (s, u, o = {}) => {
  const a = await p.chat(s, u, o);
  letzterRoh = (a.content && a.content.trim()) ? a.content : ('[aus Reasoning] ' + String(a.reasoning || '').slice(-300));
  return (a.content && a.content.trim()) ? a.content : (a.reasoning || '');
};
console.log('Experten-Block:', experten.implementierteExperten()
  .map(e => `- ${e.id}: ${e.zustaendigWenn}`).join('\n').length, 'Zeichen');
(async () => {
  for (const text of ['reservier mir bitte 4 Magna3 Pumpen für nächste Woche', 'bestell 20m Kupferrohr bei der GC']) {
    const r = await router.entscheide({ text, chatId: 342450413, chat: jsonText,
      protokoll: (t, m) => console.log('   [' + t + '] ' + m) });
    console.log(`\n"${text}"\n  -> ${r.aktion}/${r.experte} conf=${r.confidence} hinweis=${r.hinweis}`);
    console.log('  Modell sagte:', letzterRoh.slice(0, 220));
  }
})().catch(e => console.error('FEHLER:', e.message));
