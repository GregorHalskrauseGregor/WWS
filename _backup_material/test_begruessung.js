const fs = require('fs');
const b = require('../begruessung');
const text = b.ladeBegruessung();
console.log('Datei-Laenge:', text.length, 'Bytes (vorher 5283)');
console.log('Anzahl Zeilen:', text.split('\n').length, '(vorher 99)');
console.log('---');
console.log('Inhalt (erste 500 Zeichen):');
console.log(text.slice(0, 500));
console.log('...');
console.log('---');
const codeBlock = text.match(/```([\s\S]*?)```/);
if (codeBlock) {
  console.log('Code-Block gefunden, Befehle:');
  const cmds = codeBlock[1].match(/\/[a-z][a-z_-]*/g) || [];
  cmds.forEach(c => console.log('  ' + c));
} else {
  console.log('Kein Code-Block gefunden');
}
