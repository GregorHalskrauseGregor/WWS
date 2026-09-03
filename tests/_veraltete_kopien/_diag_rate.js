require('dotenv').config();
const body = (n) => JSON.stringify({
  model: process.env.MINIMAX_MODEL || 'MiniMax-M2', max_tokens: 1800,
  messages: [{ role:'system', content:'Antworte NUR mit JSON: {"n":'+n+'}' }, { role:'user', content:'Test '+n }]
});
(async () => {
  const rufe = [1,2,3,4,5,6].map(async (n) => {
    const t = Date.now();
    const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.MINIMAX_API_KEY}`},
      body: body(n)
    });
    const d = await res.json();
    const c = d.choices?.[0]?.message?.content || '';
    return `#${n}  HTTP ${res.status}  base_resp=${JSON.stringify(d.base_resp)}  content=${JSON.stringify(c.slice(0,40))}  (${Date.now()-t}ms)`;
  });
  for (const z of await Promise.all(rufe)) console.log(z);
})().catch(e=>console.error('FEHLER:',e.message));
