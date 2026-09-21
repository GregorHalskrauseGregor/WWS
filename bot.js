// Einstiegspunkt.
//
// Diese Datei verdrahtet nur noch: Konfiguration prüfen, KI-Anbieter wählen,
// Adapter starten. Der eigentliche Ablauf liegt in kern/, der Telegram-Bezug
// in adapter/telegram.js, die Fachlogik in experten/.
//
//   adapter/telegram.js   Ein- und Ausgabe (austauschbar)
//         │
//   kern/orchestrator.js  Ablauf: Router → Thema → Experte → Antwort
//         ├─ kern/router.js         EINE Entscheidung: Faden + Aktion + Experte
//         ├─ kern/vorgang.js        Vorgangszustand, am Thema (parallele Fäden)
//         ├─ kern/vorgangsmotor.js  sammeln, nachfragen, ausführen (generisch)
//         ├─ kern/werkzeuge.js      globale + experteneigene Tools
//         └─ kern/toolloop.js       Tool-Schleife mit Nutzer-Freigabe
//         │
//   experten/*.js         Fachlogik als Plugins (Auto-Load)
//   providers/, dienste/  austauschbare KI-Anbieter und Fach-APIs
//
//   kern/auftragsstelle.js  Warteschlange fuer Arbeit, die NICHT hier laufen
//   adapter/agent_http.js   kann — Browser-Navigation im Grosshaendler-Portal
//                           muss auf dem Laptop stattfinden, weil GC
//                           Rechenzentrums-IPs sperrt. Der Laptop holt sich die
//                           Auftraege ab; die Box ruft ihn nie an.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { PFADE } = require('./config');
const lagerAdapter = require('./adapter/telegram_lager');
const { getProvider, uebersicht } = require('./providers');
const fachdienste = require('./dienste');
const experten = require('./experten');
const adapter = require('./adapter/telegram');
const benachrichtigung = require('./benachrichtigung');
const auftragsstelle = require('./kern/auftragsstelle');
const agentHttp = require('./adapter/agent_http');

// ══════════════════════════════════════════════════════════════════════════
// NICHTS SOLL STILL STERBEN
// ══════════════════════════════════════════════════════════════════════════
//
// Ein Fehler in einem async-Handler, den niemand abfaengt, beendet unter Node
// den ganzen Prozess — ohne Zeile im Log, die erklaert warum. Von aussen sieht
// das aus, als haette der Bot einfach nicht reagiert: Docker startet ihn neu,
// die Nachricht ist weg, und man sucht an der falschen Stelle.
//
// Deshalb wird hier alles mitgeschrieben, was sonst unbemerkt durchginge.
process.on('unhandledRejection', (grund) => {
  const text = (grund && (grund.stack || grund.message)) || String(grund);
  console.error('\n⚠️  Unbehandelter Fehler in einem async-Aufruf:\n' + text + '\n');
});
process.on('uncaughtException', (err) => {
  console.error('\n⚠️  Unbehandelte Ausnahme:\n' + (err && err.stack || err) + '\n');
  // Bewusst KEIN process.exit: ein einzelner kaputter Handler soll nicht den
  // ganzen Bot mitnehmen. Laeuft etwas grundsaetzlich schief, faellt es im Log
  // auf, weil die Meldung dann im Sekundentakt kommt.
});

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN fehlt in der .env');
  process.exit(1);
}

// Auf Railway muss unter /app/data ein Volume liegen, sonst sind nach dem
// nächsten Deploy alle Themen, Vorgänge und das Gedächtnis weg.
try {
  fs.mkdirSync(PFADE.USERS, { recursive: true });
} catch (err) {
  console.error('WARNUNG: data/ ist nicht beschreibbar. Ohne gemountetes Volume ' +
    'gehen alle Daten beim nächsten Redeploy verloren. Ursache: ' + err.message);
}

// Ein Anbieter je Aufgabe — konfigurierbar, mit Fallback-Kette (siehe providers/index.js).
const chatProvider = getProvider('chat');
const nurText = (provider) => async (systemPrompt, userMessage, opts = {}) =>
  (await provider.chat(systemPrompt, userMessage, opts)).content;

// Reasoning-Modelle (MiniMax M2 u.a.) denken in einem eigenen Feld und geben
// erst danach die Antwort aus. Reicht das Token-Budget nicht, bleibt content
// leer, obwohl das JSON schon im Reasoning steht. Fuer Aufrufer, die JSON
// erwarten, bergen wir es von dort — bei Antworten an den Nutzer NICHT, sonst
// bekaeme er das Nachdenken des Modells zu lesen.
const jsonText = (provider) => async (systemPrompt, userMessage, opts = {}) => {
  const a = await provider.chat(systemPrompt, userMessage, opts);
  if (a.content && a.content.trim()) return a.content;
  return a.reasoning || '';
};

const antwortChat = nurText(chatProvider);
const routerChat = jsonText(getProvider('router'));
const extraktionChat = jsonText(getProvider('extraktion'));
const summaryChat = nurText(getProvider('summary'));

// Welcher Stand laeuft hier eigentlich? In einem Container ist das sonst nicht
// zu sehen — und die Frage "habe ich neu gebaut oder nicht?" hat schon mehr als
// eine Fehlersuche in die Irre gefuehrt. Das Aenderungsdatum der Quelldateien
// wandert beim Bauen mit ins Image und beantwortet sie zuverlaessig.
try {
  const juengste = ['bot.js', 'adapter/telegram.js', 'kern/router.js']
    .map((f) => { try { return fs.statSync(path.join(__dirname, f)).mtime; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  if (juengste) {
    console.log(`Code-Stand: ${juengste.toISOString().slice(0, 16).replace('T', ' ')} (juengste Quelldatei)`);
  }
} catch { /* rein informativ */ }

const geladen = experten.listeStatus();
for (const r of uebersicht()) {
  console.log(`Anbieter ${r.rolle.padEnd(11)} ${r.anbieter} (${r.modell})`);
}
for (const d of fachdienste.status()) {
  console.log(`Dienst   ${d.art.padEnd(14)} ` +
    d.kette.map((a) => `${a.name}${a.bereit ? '' : ' (kein Key)'}`).join(' -> ') || '(keiner)');
}
console.log(`Experten: ${geladen.filter((e) => e.implementiert).map((e) => e.id).join(', ') || '(keine)'}` +
  (geladen.some((e) => !e.implementiert)
    ? ` | Stubs: ${geladen.filter((e) => !e.implementiert).map((e) => e.id).join(', ')}` : ''));
adapter.starte({ token, provider: chatProvider, antwortChat, routerChat, extraktionChat, summaryChat });

// ─────────────────────────────────────────────────────────────── Auftragsstelle
//
// Nur auf der Box: dort ist AGENT_TOKEN gesetzt. Laeuft der Bot lokal auf dem
// Laptop (Direktbetrieb), bleibt das hier komplett aus und der Grosshandel-
// Experte ruft den Playwright-Dienst weiterhin unmittelbar auf.
if (process.env.AGENT_TOKEN) {
  const z = auftragsstelle.starte();
  console.log(`Auftragsstelle: ${z.offen} offen, ${z.gesamt} gesamt (${z.ordner})`);

  // Wer das Ergebnis in Worte fasst, ist Sache des Fachexperten — der Kern
  // kennt keine Bestellungen. Bewusst ueber alleExperten(): ein Experte, der
  // gerade ueber werkzeuge.md abgeschaltet wurde, soll seinen noch laufenden
  // Auftrag trotzdem zu Ende melden koennen.
  auftragsstelle.beiErgebnis(async (auftrag) => {
    if (!auftrag.chatId) return;
    const zustaendig = experten.alleExperten()
      .find((e) => (e.auftragsarten || []).includes(auftrag.art));
    const meldung = zustaendig && typeof zustaendig.auftragsMeldung === 'function'
      ? zustaendig.auftragsMeldung(auftrag)
      : { text: `Auftrag \`${auftrag.id}\` ist jetzt: ${auftrag.zustand}.`, dateien: [] };

    const r = await benachrichtigung.sende('hauptbot', auftrag.chatId, meldung.text, {
      dateien: meldung.dateien || [],
      ziel: auftrag.ziel || null
    });
    if (!r.gesendet) {
      console.error(`Auftrag ${auftrag.id}: Meldung an ${auftrag.chatId} nicht zustellbar (${r.grund})`);
    }
  });

  agentHttp.starte({
    port: Number(process.env.AGENT_PORT || 8788),
    host: process.env.AGENT_HOST || '0.0.0.0',
    token: process.env.AGENT_TOKEN
  });
} else if (process.env.GROSSHANDEL_SERVICE_URL) {
  console.log('Auftragsstelle aus (kein AGENT_TOKEN) — Grosshandel laeuft im Direktbetrieb ' +
    `gegen ${process.env.GROSSHANDEL_SERVICE_URL}.`);
}

// Zweiter Bot, nur fuer den Lageristen. Faellt aus, wenn kein Token gesetzt ist —
// der normale Betrieb laeuft dann unveraendert weiter, nur bekommt niemand die
// Reservierungen zur Bestaetigung.
lagerAdapter.starte({ token: process.env.TELEGRAM_LAGER_TOKEN });
