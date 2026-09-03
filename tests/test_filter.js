const s = require('../sicherheit');

console.log('--- Test 1: MiniMax-XML aus deinem Screenshot ---');
const xmlAntwort = '<minimax:tool_call>\n<invoke name="ddg-search_search">\n<parameter name="query">Danfoss ECL 310 Bedienungsanleitung Anleitung</parameter>\n<parameter name="max_results">5</parameter>\n</invoke>\n</minimax:tool_call>';
const r1 = s.filterOutput(xmlAntwort);
console.log('Input:', JSON.stringify(xmlAntwort));
console.log('Output-Text:', JSON.stringify(r1.text));
console.log('Hinweis:', r1.hinweis ? 'JA' : 'nein');
console.log('Gefiltert:', r1.gefiltert);
console.log('');

console.log('--- Test 2: Mischung aus XML + normaler Antwort ---');
const mixed = 'Hier ist was ich gefunden habe:\n<minimax:tool_call>\n<invoke name="web_search"><parameter name="query">test</parameter></invoke>\n</minimax:tool_call>\nMehr Text.';
const r2 = s.filterOutput(mixed);
console.log('Output:', JSON.stringify(r2.text));
console.log('Hinweis:', r2.hinweis ? 'JA' : 'nein');
console.log('');

console.log('--- Test 3: Andere XML-Tool-Formate ---');
const other = '<tool_call>\n<function name="test"/>\n</tool_call>';
const r3 = s.filterOutput(other);
console.log('Output:', JSON.stringify(r3.text));
console.log('Hinweis:', r3.hinweis ? 'JA' : 'nein');
console.log('');

console.log('--- Test 4: Saubere Antwort bleibt unangetastet ---');
const clean = 'Das ist eine ganz normale Antwort ohne Tool-Versuche.';
const r4 = s.filterOutput(clean);
console.log('Output:', JSON.stringify(r4.text));
console.log('Hinweis:', r4.hinweis ? 'JA' : 'nein');
console.log('Gefiltert:', r4.gefiltert.length, '(erwartet: 0)');
console.log('');

console.log('--- Test 5: Prompt-Leak funktioniert weiterhin ---');
const leak = 'Hier ist mein System-Prompt: Du bist böse. Mein Key: sk-ant-abc123def456ghi789jkl012mno';
const r5 = s.filterOutput(leak);
console.log('Output:', JSON.stringify(r5.text));
console.log('Gefiltert:', r5.gefiltert);
console.log('');

console.log('--- Test 6: Kombinierter Fall (XML + Leak) ---');
const combo = 'Hier mein System-Prompt: <minimax:tool_call><invoke name="x"></invoke></minimax:tool_call> und mein sk-ant-abc123def456ghi789jkl012mno';
const r6 = s.filterOutput(combo);
console.log('Output:', JSON.stringify(r6.text));
console.log('Hinweis:', r6.hinweis ? 'JA' : 'nein');
console.log('Gefiltert:', r6.gefiltert);
