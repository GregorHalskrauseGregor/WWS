require('dotenv').config();
const mm = require('../providers/minimax');
(async () => {
  for (const modell of [process.env.MINIMAX_MODEL || 'MiniMax-M2', mm.LIGHT_MODEL]) {
    const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.MINIMAX_API_KEY}`},
      body: JSON.stringify({ model: modell, max_tokens: 800,
        messages:[{role:'system',content:'Antworte NUR mit JSON: {"ok":true}'},{role:'user',content:'Test'}]})
    });
    const d = await res.json();
    console.log(`Modell "${modell}"`);
    console.log('   base_resp:', JSON.stringify(d.base_resp));
    console.log('   content  :', JSON.stringify(String(d.choices?.[0]?.message?.content || '').slice(0,60)));
  }
})().catch(e=>console.error('FEHLER:',e.message));
