// Direkter Test des Markdown-Parsers
const rueckgabe = require('../experten/material_rueckgabe');

const text1 = `Material aus dem Auftrag Müller zurück:
3 Kugelhähne DN20 gebraucht
12m Kupferrohr 22mm neu
2 Pressfittinge 18mm neu`;

console.log('Input:', JSON.stringify(text1));
console.log();
const result = rueckgabe._internals.extrahiereAusMarkdown(text1);
console.log('Result:', JSON.stringify(result, null, 2));
