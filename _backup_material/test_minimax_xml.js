// Testet den MiniMax-XML-Parser mit dem Beispiel aus dem Screenshot
// und weiteren realistischen Fällen.

const m = require('../providers/minimax');

console.log('--- Test 1: XML aus deinem Screenshot ---');
const xml1 = '<minimax:tool_call>\n<invoke name="ddg-search_search">\n<parameter name="query">Danfoss ECL 310 Bedienungsanleitung Anleitung</parameter>\n<parameter name="max_results">5</parameter>\n</invoke>\n</minimax:tool_call>';
const r1 = m.parseXMLToolCalls(xml1);
console.log('Input:', JSON.stringify(xml1));
console.log('Output:', JSON.stringify(r1, null, 2));
console.log('Tool-Name gemappt:', r1[0].name, '(erwartet: web_search)');
console.log('Original-Name:', r1[0].originalName, '(erwartet: ddg-search_search)');
console.log('Args:', JSON.stringify(r1[0].args));
console.log('');

console.log('--- Test 2: Mit unserem Standard-Tool-Namen web_search ---');
const xml2 = '<minimax:tool_call>\n<invoke name="web_search">\n<parameter name="query">test</parameter>\n<parameter name="max_results">3</parameter>\n</invoke>\n</minimax:tool_call>';
const r2 = m.parseXMLToolCalls(xml2);
console.log('Tool-Name:', r2[0].name);
console.log('Original-Name:', r2[0].originalName, '(erwartet: undefined, weil Name schon korrekt)');
console.log('Args:', JSON.stringify(r2[0].args));
console.log('');

console.log('--- Test 3: URL-Fetch mit jina-fetch ---');
const xml3 = '<minimax:tool_call>\n<invoke name="jina-fetch">\n<parameter name="url">https://example.com/artikel</parameter>\n</invoke>\n</minimax:tool_call>';
const r3 = m.parseXMLToolCalls(xml3);
console.log('Tool-Name:', r3[0].name, '(erwartet: web_fetch)');
console.log('Args:', JSON.stringify(r3[0].args));
console.log('');

console.log('--- Test 4: Mehrere Tool-Calls in einer Antwort ---');
const xml4 = 'Hier ist meine Analyse:\n\n<minimax:tool_call>\n<invoke name="web_search">\n<parameter name="query">Frage 1</parameter>\n</invoke>\n</minimax:tool_call>\n\nund\n\n<minimax:tool_call>\n<invoke name="web_fetch">\n<parameter name="url">https://example.com</parameter>\n</invoke>\n</minimax:tool_call>\n\nEnde.';
const r4 = m.parseXMLToolCalls(xml4);
console.log('Anzahl Tool-Calls:', r4.length, '(erwartet: 2)');
console.log('Names:', r4.map(c => c.name).join(', '));
console.log('');

console.log('--- Test 5: Saubere Antwort ohne Tool-Calls ---');
const clean = 'Das ist eine ganz normale Antwort ohne Tool-Aufrufe.';
const r5 = m.parseXMLToolCalls(clean);
console.log('Output:', r5, '(erwartet: null)');
console.log('');

console.log('--- Test 6: Numerische Parameter werden zu Zahlen ---');
const xml6 = '<minimax:tool_call>\n<invoke name="web_search">\n<parameter name="query">test</parameter>\n<parameter name="max_results">7</parameter>\n</invoke>\n</minimax:tool_call>';
const r6 = m.parseXMLToolCalls(xml6);
console.log('max_results type:', typeof r6[0].args.max_results, '(erwartet: number)');
console.log('Wert:', r6[0].args.max_results);
console.log('');

console.log('--- Test 7: Defensives Parsing — kaputtes XML ---');
const kaputt = '<minimax:tool_call><invoke name="web_search"><parameter name="query">';
const r7 = m.parseXMLToolCalls(kaputt);
console.log('Output:', r7, '(erwartet: null)');
console.log('');

console.log('--- Test 8: Tool-Name mit Bindestrich (z.B. "url_fetch") ---');
const xml8 = '<minimax:tool_call>\n<invoke name="url_fetch">\n<parameter name="url">https://x.com</parameter>\n</invoke>\n</minimax:tool_call>';
const r8 = m.parseXMLToolCalls(xml8);
console.log('Tool-Name gemappt:', r8[0].name, '(erwartet: web_fetch)');
