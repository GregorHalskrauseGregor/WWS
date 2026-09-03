// Smoke-Test ohne Netz und ohne Telegram: lädt alle Kernmodule, prüft die
// Experten-Registry und fährt den Vorgangs-Motor mit einem Fake-Modell durch.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test:token';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ok = 0, fehler = 0;
function pruefe(name, fn) {
  try { fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fehler++; }
}
async function pruefeAsync(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fehler++; }
}

console.log('\n── Module laden ──');
const experten = require('../experten');
const vorgang = require('../kern/vorgang');
const motor = require('../kern/vorgangsmotor');
const router = require('../kern/router');
const werkzeuge = require('../kern/werkzeuge');
const toolloop = require('../kern/toolloop');
const orchestrator = require('../kern/orchestrator');
const { extrahiere } = require('../kern/json');
const config = require('../config');
pruefe('alle Kernmodule laden', () => { assert(orchestrator.verarbeiteNachricht); });

console.log('\n── Experten-Registry ──');
const status = experten.listeStatus();
pruefe('Experten geladen', () => assert(status.length >= 5, `nur ${status.length}`));
pruefe('keine Ladefehler (alle Pflichtfelder)', () => {
  const ids = status.map((e) => e.id);
  for (const soll of ['materialaufmass', 'material_entnahme', 'material_rueckgabe', 'recherche']) {
    assert(ids.includes(soll), `${soll} fehlt — Vertragsprüfung fehlgeschlagen`);
  }
});
pruefe('Stubs werden dem Router nicht angeboten', () => {
  const impl = experten.implementierteExperten().map((e) => e.id);
  assert(!impl.includes('leistungserfassung'), 'Stub ist wählbar');
});
pruefe('jeder implementierte Experte hat zustaendigWenn', () => {
  for (const e of experten.implementierteExperten()) {
    assert(e.zustaendigWenn && e.zustaendigWenn.length > 20, `${e.id}: zu dünn`);
  }
});
pruefe('Bauarten erkannt', () => {
  assert.equal(experten.art(experten.findeExperteMitId('materialaufmass')), 'Vorgang');
  assert.equal(experten.art(experten.findeExperteMitId('recherche')), 'Prompt');
});
pruefe('Experten-Commands registriert', () => {
  const namen = experten.alleCommands().map((c) => c.name);
  assert(namen.includes('aufmass_reset'), 'aufmass_reset fehlt: ' + namen.join(','));
});

console.log('\n── JSON-Bergung ──');
pruefe('roh', () => assert.equal(extrahiere('{"a":1}').a, 1));
pruefe('in Markdown', () => assert.equal(extrahiere('Klar!\n```json\n{"a":2}\n```\n').a, 2));
pruefe('mit Text drumherum', () => assert.equal(extrahiere('Hier: {"a":3} — passt?').a, 3));
pruefe('verschachtelt', () => assert.equal(extrahiere('{"x":{"y":{"z":4}}}').x.y.z, 4));
pruefe('String mit Klammer', () => assert.equal(extrahiere('{"t":"a } b","n":5}').n, 5));
pruefe('kaputt -> null', () => assert.equal(extrahiere('kein json hier'), null));

console.log('\n── Delta-Operationen ──');
const schema = require('../experten/materialaufmass').schema;
pruefe('setze + liste_hinzu', () => {
  const r = motor.wendeOpsAn({}, [
    { op: 'setze', feld: 'projektnummer', wert: '26-0111' },
    { op: 'liste_hinzu', feld: 'positionen', wert: { menge: '12', einheit: 'm', bezeichnung: 'Kupferrohr 22mm' } }
  ], schema);
  assert.equal(r.daten.projektnummer, '26-0111');
  assert.equal(r.daten.positionen[0].menge, 12, 'Menge muss Zahl sein');
});
pruefe('liste_aendere trifft Position 2 (1-basiert)', () => {
  const start = { positionen: [{ menge: 1, bezeichnung: 'A' }, { menge: 2, bezeichnung: 'B' }] };
  const r = motor.wendeOpsAn(start, [{ op: 'liste_aendere', feld: 'positionen', index: 2, wert: { menge: 5 } }], schema);
  assert.equal(r.daten.positionen[1].menge, 5);
  assert.equal(r.daten.positionen[1].bezeichnung, 'B', 'andere Felder bleiben');
  assert.equal(r.daten.positionen[0].menge, 1, 'Position 1 unberührt');
});
pruefe('liste_entferne', () => {
  const start = { positionen: [{ bezeichnung: 'A' }, { bezeichnung: 'B' }, { bezeichnung: 'C' }] };
  const r = motor.wendeOpsAn(start, [{ op: 'liste_entferne', feld: 'positionen', index: 3 }], schema);
  assert.equal(r.daten.positionen.length, 2);
});
pruefe('ungültige Operationen werden abgelehnt, nicht geraten', () => {
  const r = motor.wendeOpsAn({ positionen: [] }, [
    { op: 'liste_aendere', feld: 'positionen', index: 9, wert: { menge: 1 } },
    { op: 'setze', feld: 'gibtsnicht', wert: 'x' },
    { op: 'quatsch', feld: 'positionen' }
  ], schema);
  assert.equal(r.abgelehnt.length, 3, 'erwartet 3 Ablehnungen, war ' + r.abgelehnt.length);
  assert.equal(r.angewandt.length, 0);
});
pruefe('Vollzustand bleibt bei leerem ops erhalten', () => {
  const start = { projektnummer: 'X', positionen: [{ bezeichnung: 'A' }] };
  const r = motor.wendeOpsAn(start, [], schema);
  assert.deepEqual(r.daten, start, 'nichts darf verloren gehen');
});

console.log('\n── Lückenprüfung ──');
pruefe('erkennt fehlende Pflichtfelder', () => {
  const f = motor.fehlendeFelder({ projektnummer: '26-0111' }, schema).map((x) => x.feld);
  assert.deepEqual(f, ['bauvorhaben', 'positionen']);
});
pruefe('vollständig erkannt', () => {
  assert(motor.istVollstaendig(
    { projektnummer: 'A', bauvorhaben: 'B', positionen: [{ menge: 1, bezeichnung: 'X' }] }, schema));
});
pruefe('leere Liste zählt als fehlend', () => {
  assert(!motor.istVollstaendig({ projektnummer: 'A', bauvorhaben: 'B', positionen: [] }, schema));
});

console.log('\n── Vorgänge hängen am Thema (parallele Fäden) ──');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-'));
pruefe('zwei Fäden, zwei unabhängige Vorgänge', () => {
  const chatId = 4242;
  const echt = config.PFADE.vorgangDatei;
  config.PFADE.vorgangDatei = (c, t) => path.join(tmp, String(c), String(t), 'vorgang.json');
  try {
    vorgang.speichere(chatId, 'thema-aaa', { experteId: 'materialaufmass', daten: { projektnummer: 'A' }, status: 'sammelt' });
    vorgang.speichere(chatId, 'thema-bbb', { experteId: 'materialaufmass', daten: { projektnummer: 'B' }, status: 'sammelt' });
    assert.equal(vorgang.lade(chatId, 'thema-aaa').daten.projektnummer, 'A');
    assert.equal(vorgang.lade(chatId, 'thema-bbb').daten.projektnummer, 'B',
      'zweiter Faden hat den ersten überschrieben');
    vorgang.loesche(chatId, 'thema-aaa');
    assert.equal(vorgang.lade(chatId, 'thema-aaa'), null);
    assert(vorgang.lade(chatId, 'thema-bbb'), 'Löschen traf den falschen Faden');
  } finally { config.PFADE.vorgangDatei = echt; }
});
pruefe('Pfad-Injection wird abgewehrt', () => {
  assert.throws(() => vorgang.pfad(123, '../../etc'), /Ungültige/);
});

console.log('\n── Router-Validierung (Fake-Modell) ──');
(async () => {
  await pruefeAsync('niedrige Confidence -> konversation', async () => {
    const r = await router.entscheide({
      text: 'hallo', chatId: 999,
      chat: async () => '{"thema":"neu","themaName":"Test","aktion":"verarbeiten","experte":"materialaufmass","confidence":0.3}'
    });
    assert.equal(r.aktion, 'konversation', 'Schwelle nicht angewendet');
  });
  await pruefeAsync('halluzinierter Experte wird verworfen', async () => {
    const r = await router.entscheide({
      text: 'x', chatId: 999,
      chat: async () => '{"thema":"neu","aktion":"verarbeiten","experte":"gibtsnicht","confidence":0.99}'
    });
    assert.equal(r.aktion, 'konversation');
  });
  await pruefeAsync('Stub kann nicht gewählt werden', async () => {
    const r = await router.entscheide({
      text: 'rechnung', chatId: 999,
      chat: async () => '{"thema":"neu","aktion":"verarbeiten","experte":"leistungserfassung","confidence":0.95}'
    });
    assert.equal(r.aktion, 'konversation', 'Stub wurde aktiviert');
  });
  await pruefeAsync('gültige Entscheidung kommt durch', async () => {
    const r = await router.entscheide({
      text: '12m Kupferrohr verlegt', chatId: 999,
      chat: async () => '{"thema":"neu","themaName":"Aufmaß Müller","aktion":"verarbeiten","experte":"materialaufmass","confidence":0.9}'
    });
    assert.equal(r.aktion, 'verarbeiten');
    assert.equal(r.experte, 'materialaufmass');
    assert.equal(r.thema.neu, true);
    assert.equal(r.thema.name, 'Aufmaß Müller');
  });
  await pruefeAsync('Müll vom Modell -> sicherer Rückfall', async () => {
    const r = await router.entscheide({ text: 'x', chatId: 999, chat: async () => 'ich bin ein Chatbot!' });
    assert.equal(r.aktion, 'konversation');
    assert.equal(r.confidence, 0);
  });

  console.log('\n── Werkzeug-Registry ──');
  await pruefeAsync('Experten-Tools werden angeboten und ausgeführt', async () => {
    const fake = { id: 'x', tools: [{ name: 'test_tool', beschreibung: 'T', ausfuehren: async (a) => 'echo:' + a.v }] };
    const w = werkzeuge.fuerExperte(fake, { supportsTools: true });
    assert(w.definitionen.some((d) => d.name === 'test_tool'), 'Tool fehlt in den Definitionen');
    assert.equal(await w.ausfuehren('test_tool', { v: 1 }), 'echo:1');
  });
  await pruefeAsync('Tool-Fehler stürzen nicht durch', async () => {
    const fake = { id: 'x', tools: [{ name: 'kaputt', ausfuehren: async () => { throw new Error('bumm'); } }] };
    const w = werkzeuge.fuerExperte(fake, { supportsTools: true });
    assert.match(await w.ausfuehren('kaputt', {}), /Fehler im Werkzeug/);
  });

  console.log('\n── Tool-Loop ──');
  await pruefeAsync('Ablehnung beendet die Schleife sauber', async () => {
    let runden = 0;
    const provider = {
      name: 'anthropic',
      chat: async () => {
        runden++;
        return runden === 1
          ? { content: '', toolCalls: [{ id: 't1', name: 'web_search', args: { query: 'x' } }] }
          : { content: 'Antwort ohne Tool', toolCalls: [] };
      }
    };
    const text = await toolloop.laufe({
      chatId: 1, systemPrompt: 's', messages: [{ role: 'user', content: 'q' }],
      werkzeuge: { definitionen: [{ name: 'web_search' }], ausfuehren: async () => 'nie' },
      provider,
      dienste: { frageBestaetigung: async () => ({ erlaubt: false, grund: 'Test' }), protokoll: () => {} }
    });
    assert.equal(text, 'Antwort ohne Tool');
  });
  await pruefeAsync('Iterationslimit greift', async () => {
    const provider = {
      name: 'anthropic',
      chat: async () => ({ content: '', toolCalls: [{ id: 't', name: 'web_search', args: {} }] })
    };
    const text = await toolloop.laufe({
      chatId: 1, systemPrompt: 's', messages: [],
      werkzeuge: { definitionen: [{ name: 'web_search' }], ausfuehren: async () => 'ergebnis' },
      provider,
      dienste: { frageBestaetigung: async () => ({ erlaubt: true }), protokoll: () => {} }
    });
    assert.match(text, /abgebrochen/);
  });

  console.log('\n── Neue Experten (Test der Architektur) ──');
  pruefe('Bestellung ist ein Vorgangs-Experte', () => {
    const b = experten.findeExperteMitId('bestellung');
    assert.equal(experten.art(b), 'Vorgang');
    assert(b.schema.lieferant.pflicht && b.schema.positionen.pflicht);
    assert.equal(typeof b.finalisiere, 'function');
  });
  pruefe('Bestellung braucht keine eigene Sammel-Logik mehr', () => {
    const quelle = fs.readFileSync(path.join(__dirname, '..', 'experten', 'bestellung.js'), 'utf-8');
    for (const verboten of ['ladeSession', 'JSON.parse', 'fehltEtwas', 'extrahiereJson']) {
      assert(!quelle.includes(verboten), `bestellung.js macht wieder ${verboten} selbst`);
    }
  });
  pruefe('Lagerauskunft bringt eigene Werkzeuge mit', () => {
    const l = experten.findeExperteMitId('lagerauskunft');
    assert.deepEqual(l.tools.map((t) => t.name), ['bestand_suchen', 'bedarf_pruefen', 'ganze_liste']);
  });
  pruefe('nurEigeneTools blendet die Web-Tools aus', () => {
    const l = experten.findeExperteMitId('lagerauskunft');
    const w = werkzeuge.fuerExperte(l, { supportsTools: true });
    assert(!w.definitionen.some((d) => d.name === 'web_search'), 'Web-Suche wurde trotzdem angeboten');
    assert.equal(w.definitionen.length, 3);
  });

  console.log('\n── Kern kennt keinen Experten namentlich ──');
  pruefe('kein Experten-Name in Kern, Adapter oder Einstieg', () => {
    const ids = experten.alleExperten().map((e) => e.id);
    for (const datei of ['kern/orchestrator.js', 'kern/router.js', 'kern/vorgangsmotor.js',
                         'kern/werkzeuge.js', 'adapter/telegram.js', 'bot.js']) {
      const quelle = fs.readFileSync(path.join(__dirname, '..', datei), 'utf-8');
      for (const id of ids) {
        assert(!quelle.includes(`'${id}'`) && !quelle.includes(`"${id}"`),
          `${datei} nennt den Experten "${id}" beim Namen`);
      }
    }
  });

  console.log('\n── Dienste-Registry ──');
  const fachdienste = require('../dienste');
  pruefe('alle vier Arten registriert', () => {
    assert.deepEqual(fachdienste.status().map((d) => d.art), ['ocr', 'transkription', 'suche', 'lesen']);
  });
  pruefe('jeder Dienst nennt seinen benötigten Key', () => {
    for (const d of fachdienste.status()) {
      for (const a of d.kette) assert(a.benoetigt !== undefined, `${d.art}/${a.name}`);
    }
  });
  await pruefeAsync('fehlender Key -> klare Meldung statt Absturz', async () => {
    const alt = process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    try {
      await fachdienste.ocr(Buffer.from('x'), 'image/jpeg');
      throw new Error('haette scheitern muessen');
    } catch (e) {
      assert.match(e.message, /MISTRAL_API_KEY|Kein nutzbarer/);
    } finally { if (alt) process.env.MISTRAL_API_KEY = alt; }
  });

  console.log('\n── Anbieter-Rollen ──');
  const providers = require('../providers');
  pruefe('vier Aufgaben-Rollen', () => {
    assert.deepEqual(providers.uebersicht().map((r) => r.rolle),
      ['chat', 'extraktion', 'router', 'summary']);
  });
  pruefe('Rolle einzeln konfigurierbar', () => {
    const alt = process.env.AI_PROVIDER_ROUTER;
    process.env.AI_PROVIDER_ROUTER = 'openai';
    try { assert.equal(providers.getProvider('router').name, 'openai'); }
    finally { if (alt) process.env.AI_PROVIDER_ROUTER = alt; else delete process.env.AI_PROVIDER_ROUTER; }
  });
  pruefe('Fallback nur bei Ausfall-Fehlern, nicht bei Programmfehlern', () => {
    assert(providers._lohntFallback(new Error('HTTP 429 rate limit')));
    assert(providers._lohntFallback(new Error('fetch failed')));
    assert(!providers._lohntFallback(new TypeError('x is not a function')));
  });
  pruefe('main/light bleiben rueckwaertskompatibel', () => {
    assert(providers.getProvider('main').name);
    assert(providers.getProvider('light').name);
  });

  console.log('\n── Regression: Router-Ausfall zersplittert den Chat nicht ──');
  // Echter Vorfall: MiniMax lieferte leere Antworten, der Router legte bei jeder
  // Nachricht ein neues Thema an — vier Nachrichten, vier Themen, kein Kontext.
  const themenModul = require('../themen');
  const echtLadeIndex = themenModul.ladeIndex;
  const fakeThemen = [
    { id: 'thema-neuestes', name: 'Aufmaß Müller', messageCount: 4, lastActivity: '2026-09-03T12:30:00Z' },
    { id: 'thema-aelter', name: 'Anleitung', messageCount: 2, lastActivity: '2026-09-01T09:00:00Z' }
  ];
  themenModul.ladeIndex = () => fakeThemen;
  try {
    await pruefeAsync('leere Modellantwort -> juengstes Thema, NICHT neu', async () => {
      const r = await router.entscheide({ text: '16 Stück', chatId: 1, chat: async () => '' });
      assert.equal(r.thema.neu, false, 'hat ein neues Thema angelegt');
      assert.equal(r.thema.id, 'thema-neuestes');
      assert.equal(r.aktion, 'konversation');
    });
    await pruefeAsync('halluzinierte Themen-ID -> juengstes Thema', async () => {
      const r = await router.entscheide({ text: 'x', chatId: 1,
        chat: async () => '{"thema":"thema-gibtsnicht","aktion":"konversation","confidence":0.9}' });
      assert.equal(r.thema.id, 'thema-neuestes', 'ID wurde nicht abgefangen');
    });
    await pruefeAsync('ausdrueckliches "neu" wird respektiert', async () => {
      const r = await router.entscheide({ text: 'ganz anderes Thema', chatId: 1,
        chat: async () => '{"thema":"neu","themaName":"Neue Sache","aktion":"konversation","confidence":0.9}' });
      assert.equal(r.thema.neu, true);
      assert.equal(r.thema.name, 'Neue Sache');
    });
    await pruefeAsync('bestehende ID wird uebernommen', async () => {
      const r = await router.entscheide({ text: 'dazu noch was', chatId: 1,
        chat: async () => '{"thema":"thema-aelter","aktion":"konversation","confidence":0.9}' });
      assert.equal(r.thema.id, 'thema-aelter');
    });
    await pruefeAsync('zweiter Versuch bei leerer erster Antwort', async () => {
      let ruf = 0;
      const r = await router.entscheide({ text: 'Aufmaß 12m Rohr', chatId: 1, chat: async () => {
        ruf++;
        return ruf === 1 ? '' : '{"thema":"neu","aktion":"verarbeiten","experte":"materialaufmass","confidence":0.9}';
      } });
      assert.equal(ruf, 2, 'kein zweiter Versuch unternommen');
      assert.equal(r.experte, 'materialaufmass');
    });

    console.log('\n── Regression: Formfehler des Modells abfangen ──');
    await pruefeAsync('Experten-ID im Feld "aktion"', async () => {
      const r = await router.entscheide({ text: 'brauche eine Anleitung', chatId: 1,
        chat: async () => '{"thema":"neu","aktion":"recherche","confidence":0.95}' });
      assert.equal(r.aktion, 'verarbeiten');
      assert.equal(r.experte, 'recherche');
    });
    await pruefeAsync('ID mit deutschem ß wird erkannt', async () => {
      const r = await router.entscheide({ text: 'Aufmaß', chatId: 1,
        chat: async () => '{"thema":"neu","aktion":"verarbeiten","experte":"materialaufmaß","confidence":0.9}' });
      assert.equal(r.experte, 'materialaufmass', 'ß-Schreibweise nicht abgefangen');
    });
    await pruefeAsync('Stub bleibt trotz Nachsicht gesperrt', async () => {
      const r = await router.entscheide({ text: 'rechnung', chatId: 1,
        chat: async () => '{"thema":"neu","aktion":"leistungserfassung","confidence":0.99}' });
      assert.equal(r.aktion, 'konversation');
    });
  } finally { themenModul.ladeIndex = echtLadeIndex; }

  console.log('\n── Regression: MiniMax-Fehler in HTTP-200-Antwort ──');
  // MiniMax meldet Fehler im Rumpf, nicht im Status. Vorher kam dabei still
  // ein leerer String zurueck, den der Aufrufer fuer eine Antwort hielt.
  const minimax = require('../providers/minimax');
  const echtesFetch = global.fetch;
  await pruefeAsync('unbekanntes Modell wirft statt leer zurueckzugeben', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({
      base_resp: { status_code: 2013, status_msg: "invalid params, unknown model 'minimax-m2-mini'" },
      choices: [{ message: { content: '' } }]
    }) });
    try {
      await minimax.chat('sys', 'user', {});
      throw new Error('haette werfen muessen');
    } catch (e) {
      assert.match(e.message, /2013/, 'Fehlercode fehlt: ' + e.message);
    } finally { global.fetch = echtesFetch; }
  });
  await pruefeAsync('ohne MINIMAX_MODEL_LIGHT wird kein Modellname geraten', async () => {
    let gesendet = null;
    global.fetch = async (url, opt) => {
      gesendet = JSON.parse(opt.body);
      return { ok: true, json: async () => ({ base_resp: { status_code: 0 }, choices: [{ message: { content: 'ok' } }] }) };
    };
    const altLight = process.env.MINIMAX_MODEL_LIGHT;
    delete process.env.MINIMAX_MODEL_LIGHT;
    process.env.MINIMAX_MODEL = 'MiniMax-M2';
    try {
      await minimax.chat('s', 'u', { rolle: 'light' });
      assert.equal(gesendet.model, 'MiniMax-M2', 'geratenes Light-Modell: ' + gesendet.model);
    } finally {
      global.fetch = echtesFetch;
      if (altLight) process.env.MINIMAX_MODEL_LIGHT = altLight;
    }
  });

  console.log('\n── MERKE-Hooks ──');
  pruefe('Fakt wird herausgeschnitten', () => {
    const r = orchestrator._trenneMerkeHooks('Alles klar.\n[MERKE: mag Kaffee]');
    assert.equal(r.sichtbar, 'Alles klar.');
    assert.equal(r.fakt, 'mag Kaffee');
  });

  console.log(`\n${'─'.repeat(46)}\nErgebnis: ${ok} bestanden, ${fehler} fehlgeschlagen\n`);
  process.exit(fehler > 0 ? 1 : 0);
})();
