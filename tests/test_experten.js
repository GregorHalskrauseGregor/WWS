const e = require('../experten');

console.log('--- Geladene Experten ---');
const liste = e.listeStatus();
liste.forEach(x => {
  const status = x.implementiert ? '✅ aktiv  ' : '🚧 Stub  ';
  console.log('  ' + status + ' ' + x.emoji + ' ' + x.name + ' (' + x.id + ')');
  console.log('           Trigger (erste 4): ' + x.triggers.slice(0, 4).join(', '));
});
console.log('');

console.log('--- Trigger-Matching Tests ---');
const tests = [
  'suche nach dem wetter in Berlin',
  'ich habe 5 kugelhähne montiert',
  'bitte eine rechnung erstellen',
  'wir brauchen 10 rohre',
  '3 kugelhähne zurück ins lager',
  '2 fittinge entnommen',
  'hallo, wie geht es dir',
  'kannst du im internet nach fotosynthese suchen?',
  'ich nehme 3 rohre mit',
  'bestellung aufgeben: 10 ventil DN20',
  'aufmaß für die baustelle müller'
];
tests.forEach(t => {
  const m = e.findeExperte(t);
  const label = m ? m.emoji + ' ' + m.name + ' (' + m.id + ')' : '(kein Experte → Standard-Chat)';
  console.log('  "' + t + '"');
  console.log('    → ' + label);
});
console.log('');

console.log('--- Stub-Aufruf testen ---');
const stub = e.findeExperte('bitte eine rechnung erstellen');
if (stub) {
  stub.verarbeite({ chatId: 999, text: 'test' }, {}).then(r => {
    console.log('  Stub-Experte "' + stub.id + '" antwortet:');
    console.log('  "' + r.antwort + '"');
  }).catch(err => console.log('  FEHLER: ' + err.message));
}
