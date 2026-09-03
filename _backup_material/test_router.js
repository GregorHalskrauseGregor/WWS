// Testet den Router gegen die Fälle aus den Screenshots.

const router = require('../lib/router');

// Mock-KI: gibt je nach Input unterschiedliche JSON-Antworten zurück
function mockKI(szenarien) {
  return async (systemPrompt, userMessage) => {
    const text = userMessage.toLowerCase();
    for (const s of szenarien) {
      if (text.includes(s.match.toLowerCase())) {
        return JSON.stringify(s.response);
      }
    }
    return JSON.stringify({ aktion: 'konversation', confidence: 0.5 });
  };
}

async function test(name, userText, dokInfo, kiResponse, expectedAktion, expectedExperte) {
  console.log('\n=== ' + name + ' ===');
  console.log('  User:', userText.slice(0, 80));
  if (dokInfo) console.log('  Datei:', dokInfo.name, '(' + dokInfo.mimeType + ')');
  const result = await router.routingEntscheidung({
    text: userText,
    dokInfo,
    chatId: 99999,
    kontext: { mainChat: mockKI([{ match: userText.slice(0, 40), response: kiResponse }]) }
  });
  console.log('  → Aktion:', result.aktion, '| Experte:', result.experte, '| Conf:', result.confidence.toFixed(2));
  console.log('  → Hinweis:', result.hinweis);
  if (result.aktion === expectedAktion && (!expectedExperte || result.experte === expectedExperte)) {
    console.log('  ✅ PASS');
  } else {
    console.log('  ❌ FAIL — erwartet:', expectedAktion, expectedExperte || '');
  }
}

async function run() {
  // Aus dem Chatverlauf des Users:

  // 1. "logablend mit der höchsten leistung in seiner kategorie"
  //    → sollte NICHT in Leistungserfassung gehen (Stub)
  //    → sollte als Konversation behandelt werden (Recherche, falls überhaupt)
  await test(
    'Test 1: "logablend mit höchster Leistung" — keine Stub-Aktivierung',
    'logablend mit der höchsten leistung in seiner kategorie',
    null,
    { aktion: 'konversation', confidence: 0.85, hinweis: 'Technische Eigenschaft, keine Rechnung' },
    'konversation',
    null
  );

  // 2. "Ich brauche jetzt eine Anleitung für Buderus Gaskessel 325"
  //    → sollte NICHT in Bestellung gehen (Stub)
  //    → sollte als Recherche laufen
  await test(
    'Test 2: "brauche Anleitung" — keine Bestellung, sondern Recherche',
    'ich brauche jetzt eine anleitung für Buderus Gaskessel 325',
    null,
    { aktion: 'verarbeiten', experte: 'recherche', confidence: 0.92, hinweis: 'Recherche nach Anleitung' },
    'verarbeiten',
    'recherche'
  );

  // 3. "Siche im netz nach einer Anleitung für ECL310 regler"
  //    → Recherche (nicht Materialaufmaß, auch wenn aktive Session)
  await test(
    'Test 3: "im netz nach Anleitung" — explizit Recherche',
    'siche im netz nach einer anleitung für ECL310 regler',
    null,
    { aktion: 'verarbeiten', experte: 'recherche', confidence: 0.95, hinweis: 'Web-Recherche' },
    'verarbeiten',
    'recherche'
  );

  // 4. PDF schicken, das eine VORLAGE ist (z.B. Aufmass_Zienert_ausfuellbar.pdf)
  //    → vorlage_speichern
  await test(
    'Test 4: "PDF Aufmass_X_ausfuellbar.pdf" — als Vorlage speichern',
    'hier ist das musteraufmaß',
    {
      name: 'Aufmass_Zienert_ausfuellbar.pdf',
      mimeType: 'application/pdf',
      size: 50000,
      pfad: '/tmp/test.pdf'
    },
    { aktion: 'vorlage_speichern', dok_typ: 'vorlage', confidence: 0.9, hinweis: 'Leeres Formular, AcroForm-Vorlage' },
    'vorlage_speichern',
    null
  );

  // 5. Diktat mit 9 Positionen (klassischer Materialaufmaß-Fall)
  await test(
    'Test 5: Diktat "Erstelle ein Materialaufmaß für 10 Stück Meblerbögen..."',
    'Erstelle mir bitte ein Materialaufmaß für 16er Meblerbögen, 10 Stück.',
    null,
    { aktion: 'verarbeiten', experte: 'materialaufmass', confidence: 0.95, hinweis: 'Diktierte Aufmaß-Positionen' },
    'verarbeiten',
    'materialaufmass'
  );

  // 6. Lieferschein (Foto/PDF) → Material-Rückgabe
  await test(
    'Test 6: "Foto vom Lieferschein" → Material-Rückgabe',
    'habe gerade den Lieferschein fotografiert',
    {
      name: 'lieferschein.jpg',
      mimeType: 'image/jpeg',
      size: 200000
    },
    { aktion: 'verarbeiten', experte: 'material_rueckgabe', confidence: 0.88, hinweis: 'Lieferschein, Materialeingang' },
    'verarbeiten',
    'material_rueckgabe'
  );

  // 7. "Starten wir mit der Leistungserfassung" — Stub, soll NICHT gehen
  //    Die KI sollte konversation sagen, weil leistungserfassung kein
  //    implementierter Experte ist
  await test(
    'Test 7: "Leistungserfassung" — Stub wird gefiltert',
    'starten wir mit der leistungserfassung',
    null,
    { aktion: 'konversation', confidence: 0.9, hinweis: 'Leistungserfassung ist ein Stub, keine Aktion möglich' },
    'konversation',
    null
  );

  // 8. "Hallo, wie geht es dir?" — Standard-Chat
  await test(
    'Test 8: Normale Konversation',
    'Hallo, wie geht es dir?',
    null,
    { aktion: 'konversation', confidence: 0.95, hinweis: 'Normale Begrüßung' },
    'konversation',
    null
  );

  // 9. "Ich sende gleich X" — Ankündigung, keine Aktion
  await test(
    'Test 9: "ich sende gleich X" — Ankündigung, keine Aktion',
    'ich sende dire nun PDF und unterschrift für das aufmaß',
    null,
    { aktion: 'konversation', confidence: 0.85, hinweis: 'Ankündigung, der User schickt gleich etwas — abwarten' },
    'konversation',
    null
  );

  // 10. Niedrige Confidence → Standard-Chat
  await test(
    'Test 10: Niedrige Confidence (0.4)',
    'irgendwas',
    null,
    { aktion: 'verarbeiten', experte: 'recherche', confidence: 0.4 },
    'konversation',  // <— fällt zurück wegen niedriger Confidence
    null
  );
}

run().catch(e => { console.error('FEHLER:', e); process.exit(1); });
