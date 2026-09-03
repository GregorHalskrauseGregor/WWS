// Reproduziert den Screenshot-Fall: KI gibt Markdown statt JSON.
// Test: wird die Markdown-Antwort vom neuen Parser korrekt in JSON konvertiert?

const matExp = require('../experten/materialaufmass');

// Test 1: KI gibt Markdown (wie im Screenshot zu sehen war)
const mdAntwort = `**Projekt-Nr.:** 26-0111
**Bezeichnung:** Heizraumumbau
**Datum:** 15.01.2025

---

| Pos. | Material | Menge | Einheit |
|------|----------|-------|---------|
| 1 | Schwarzrohr DN 50 | 12 | m |
| 2 | KFR-Ventil 1" (Rotguss) | 1 | St. |

---

**Gesamtübersicht:**
- Schwarzrohr DN 50: **12 m**
- KFR-Ventil 1": **1 Stück**

---

Falls du noch weitere Positionen ergänzen möchtest oder Änderungen brauchst, sag einfach Bescheid.`;

console.log('--- Test 1: Markdown-Antwort (wie im Screenshot) ---');
const r1 = matExp._internals.extrahiereJson(mdAntwort);
console.log('Ergebnis:', JSON.stringify(r1, null, 2));
console.log('Projekt:', r1.projekt);
console.log('Positionen:', r1.positionen.length);
console.log('Vollstaendig:', r1.vollstaendig);
console.log('');

// Test 2: Saubere JSON-Antwort
const jsonAntwort = JSON.stringify({
  projekt: { nummer: 'PRJ-001', bezeichnung: 'Test' },
  positionen: [{ name: 'Material', menge: 1, einheit: 'Stk.', artikelnummer: null }],
  vollstaendig: true,
  fehlt: []
});
console.log('--- Test 2: Saubere JSON-Antwort ---');
const r2 = matExp._internals.extrahiereJson(jsonAntwort);
console.log('Ergebnis:', JSON.stringify(r2.projekt) + ' / ' + r2.positionen.length + ' Positionen');
console.log('');

// Test 3: JSON in Markdown-Codeblock
const mdCodeBlock = 'Hier ist die Antwort:\n\n```json\n' + jsonAntwort + '\n```\n\nFertig.';
console.log('--- Test 3: JSON in Markdown-Codeblock ---');
const r3 = matExp._internals.extrahiereJson(mdCodeBlock);
console.log('Ergebnis:', JSON.stringify(r3.projekt) + ' / ' + r3.positionen.length + ' Positionen');
console.log('');

// Test 4: Leere Bestätigung ("passt", "fertig")
const passtAntwort = '{"projekt":{"nummer":null,"bezeichnung":null},"positionen":[],"vollstaendig":false,"fehlt":["Projektnummer","Bezeichnung","mindestens 1 Position"]}';
console.log('--- Test 4: Leere Bestätigung ---');
const r4 = matExp._internals.extrahiereJson(passtAntwort);
console.log('Ergebnis:', JSON.stringify(r4));
console.log('Vollstaendig:', r4.vollstaendig, '(erwartet: false)');
console.log('');

console.log('--- Alle Tests beendet ---');
