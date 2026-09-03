require('dotenv').config();
const themen = require('../themen');
const experten = require('../experten');
const vorgang = require('../kern/vorgang');
const CHAT = 342450413;

// Exakt den Prompt nachbauen, den entscheide() erzeugt
const liste = experten.implementierteExperten();
const index = themen.ladeIndex(CHAT);
const offen = new Map(vorgang.offeneVorgaenge(CHAT).map(o => [o.themaId, o]));
const themenBlock = index.length ? index.slice(0,12).map(t => {
  const o = offen.get(t.id);
  return `- ${t.id} | "${t.name}" | ${t.messageCount||0} Nachrichten` + (o ? `\n    OFFENER VORGANG: ${o.experteId}` : '');
}).join('\n') : '(noch keine)';
const expertenBlock = liste.map(e => `- ${e.id} (${e.name}): ${e.zustaendigWenn}`).join('\n');
const verlauf = (themen.letzteNachrichten(CHAT, 4)||[]).map(m => `${m.rolle==='user'?'User':'Bot'}: ${m.inhalt}`).join('\n');

const router = require('../kern/router');
// den echten Prompt über eine abgefangene chat-Funktion holen
(async () => {
  let echterPrompt = null;
  await router.entscheide({ text: 'Aufmaß für 10 Bögen, 8m Schwarzrohr DN100', chatId: CHAT,
    chat: async (sys) => { if (!echterPrompt) echterPrompt = sys; return ''; } });
  console.log('Echter Router-Prompt:', echterPrompt.length, 'Zeichen');
  console.log('  davon Experten-Block:', expertenBlock.length, '| Themen-Block:', themenBlock.length, '| Verlauf:', verlauf.length);

  const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.MINIMAX_API_KEY}`},
    body: JSON.stringify({ model: process.env.MINIMAX_MODEL_LIGHT || process.env.MINIMAX_MODEL || 'MiniMax-M2',
      max_tokens: 1800,
      messages:[{role:'system',content:echterPrompt},{role:'user',content:'NACHRICHT:\nAufmaß für 10 Bögen, 8m Schwarzrohr DN100'}]})
  });
  const d = await res.json();
  const m = d.choices?.[0]?.message||{};
  console.log('\nModell:', d.model, '| base_resp:', JSON.stringify(d.base_resp));
  console.log('finish_reason:', d.choices?.[0]?.finish_reason, '| usage:', JSON.stringify(d.usage));
  console.log('content  :', JSON.stringify(String(m.content||'').slice(0,250)));
  console.log('reasoning:', JSON.stringify(String(m.reasoning_content||'').slice(0,200)));
})().catch(e=>console.error('FEHLER:',e.message));
