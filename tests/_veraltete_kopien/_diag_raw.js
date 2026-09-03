require('dotenv').config();
const experten = require('../experten');
(async () => {
  // Denselben langen Prompt bauen wie der Router
  const lang = 'Du bist der Router eines Handwerker-Bots (SHK). '.repeat(1) +
    experten.implementierteExperten().map(e => `- ${e.id}: ${e.zustaendigWenn}`).join('\n') +
    '\n\nAntworte NUR mit einem JSON-Objekt: {"thema":"neu","aktion":"verarbeiten","experte":"materialaufmass","confidence":0.9}';
  for (const [label, sys] of [['KURZ', 'Antworte NUR mit JSON: {"a":1}'], ['LANG (Router-artig)', lang]]) {
    const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}` },
      body: JSON.stringify({
        model: process.env.MINIMAX_MODEL_LIGHT || process.env.MINIMAX_MODEL || 'MiniMax-M2',
        max_tokens: 1800,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Aufmaß für 10 Bögen, 8m Schwarzrohr DN100' }]
      })
    });
    const d = await res.json();
    console.log(`\n===== ${label} (System-Prompt ${sys.length} Zeichen) =====`);
    console.log('HTTP:', res.status, '| base_resp:', JSON.stringify(d.base_resp));
    console.log('finish_reason:', d.choices?.[0]?.finish_reason, '| usage:', JSON.stringify(d.usage));
    const m = d.choices?.[0]?.message || {};
    console.log('content  :', JSON.stringify(String(m.content || '').slice(0, 200)));
    console.log('reasoning:', JSON.stringify(String(m.reasoning_content || '').slice(0, 150)));
  }
})().catch(e => console.error('FEHLER:', e.message));
