// Testet, dass /options die Datei korrekt liest und formatiert.

const fs = require('fs');
const path = require('path');

const optionsPfad = path.join(__dirname, '..', 'data', 'options.json');
console.log('options.json existiert:', fs.existsSync(optionsPfad));
const opts = JSON.parse(fs.readFileSync(optionsPfad, 'utf-8'));

console.log('Name:', opts.name);
console.log('Kategorien:');
for (const kat of opts.kategorien) {
  console.log('  ' + kat.name);
  for (const b of kat.befehle) {
    console.log('    ' + b.cmd + ' — ' + b.desc);
  }
}

// Simuliere die Formatierung wie in bot.js
const lines = [];
lines.push('*' + opts.name + '*');
if (opts.kurzbeschreibung) lines.push('_' + opts.kurzbeschreibung + '_');
lines.push('');
lines.push('*Kann:*');
for (const f of opts.funktionen) lines.push('  • ' + f);
lines.push('');
for (const kat of opts.kategorien) {
  lines.push('*' + kat.name + '*');
  for (const b of kat.befehle) {
    lines.push('  `' + b.cmd + '` — ' + b.desc);
  }
  lines.push('');
}
lines.push('*Hinweise:*');
for (const h of opts.hinweise) lines.push('  ' + h);

console.log();
console.log('=== Formatierte Ausgabe (wird an Telegram geschickt) ===');
console.log(lines.join('\n'));
