// Orchestrator — der komplette Ablauf einer Nachricht, ohne jeden Telegram-Bezug.
//
// Vorher lag das in bot.js zwischen Transport, Commands und Experten-Sonderfällen.
// Diese Datei kennt kein Telegram, keine Inline-Buttons und keinen einzigen
// Experten namentlich. Sie liefert ein neutrales Ergebnis, das ein Adapter
// rendert:
//
//   { text, dateien: [pfade], knoepfe: [{text, daten}] }

const fs = require('fs');
const path = require('path');

const { SCHWELLEN, PFADE } = require('../config');
const themen = require('../themen');
const gedaechtnis = require('../gedaechtnis');
const kompressor = require('../kompressor');
const kontext = require('../kontext');
const sicherheit = require('../sicherheit');
const ratelimit = require('../ratelimit');
const experten = require('../experten');

const router = require('./router');
const vorgangSpeicher = require('./vorgang');
const vorgangsmotor = require('./vorgangsmotor');
const werkzeuge = require('./werkzeuge');
const toolloop = require('./toolloop');

// ────────────────────────────────────────────────────────────────── Helfer

// [MERKE: ...]-Zeilen aus der KI-Antwort schneiden. Die Entscheidung, sich
// etwas zu merken, trifft die KI; das Herausschneiden und Speichern ist Code.
function trenneMerkeHooks(antwort) {
  if (!antwort) return { sichtbar: '', fakt: null };
  const merken = [];
  const sichtbar = [];
  for (const zeile of antwort.split('\n')) {
    const m = zeile.match(/^\s*\[MERKE:\s*(.+?)\s*\]\s*$/i);
    if (m) merken.push(m[1].trim());
    else sichtbar.push(zeile);
  }
  return { sichtbar: sichtbar.join('\n').trim(), fakt: merken.length ? merken.join('; ') : null };
}

function sichererDateiname(name, fallback) {
  const basis = path.basename(String(name || fallback));
  return basis.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || fallback;
}

// Legt eine hochgeladene Datei im passenden Ordner ab (Router-Entscheidung).
function legeDateiAb(chatId, datei, aktion) {
  const ziele = {
    vorlage_speichern: { ordner: PFADE.VORLAGEN, was: 'Vorlage', wo: 'data/aufnahme_vorlage/' },
    style_speichern: { ordner: PFADE.STYLE, was: 'Style-Sheet', wo: 'data/style_sheet/' },
    dokument_speichern: { ordner: path.join(PFADE.ANHAENGE, String(chatId)), was: 'Anhang', wo: `data/anhaenge/${chatId}/` }
  };
  const ziel = ziele[aktion];
  if (!ziel) return null;
  fs.mkdirSync(ziel.ordner, { recursive: true });
  const name = sichererDateiname(datei.name, `datei-${Date.now()}`);
  fs.writeFileSync(path.join(ziel.ordner, name), datei.buffer);
  return { text: `✅ ${ziel.was} gespeichert als \`${name}\` unter \`${ziel.wo}\`.` };
}

// Komprimierung läuft im Hintergrund, damit der Nutzer nicht wartet.
function komprimiereSpaeter(chatId, themaId, dienste) {
  (async () => {
    const t = themen.ladeThema(chatId, themaId);
    if (t && kompressor.themaBereitZurKomprimierung(t)) {
      await kompressor.komprimiereThema(chatId, themaId, dienste.lightChat);
    }
    if (gedaechtnis.istVoll(chatId)) {
      await kompressor.komprimiereGedaechtnis(chatId, dienste.lightChat);
    }
  })().catch((err) => dienste.protokoll?.('Fehler', `Komprimierung (${themaId}): ${err.message}`));
}

// ─────────────────────────────────────────────────────────────── Hauptablauf

async function verarbeiteNachricht({ chatId, text, dokInhalt = '', dokInfo = null, datei = null }, dienste) {
  // 0) Limit vor allem anderen — kein KI-Aufruf, wenn der Nutzer drüber ist.
  const limit = ratelimit.pruefeNachricht(chatId);
  if (!limit.ok) {
    dienste.protokoll?.('Sicherheit', `Rate-Limit blockt ${chatId}: ${limit.grund}`);
    return { text: '⛔ ' + limit.grund };
  }
  ratelimit.zaehleNachricht(chatId);

  // 1) EINE Entscheidung: welcher Faden, welche Aktion, welcher Experte.
  const routing = await router.entscheide({ text, dokInfo, chatId, chat: dienste.mainChat });
  dienste.protokoll?.('Router',
    `thema=${routing.thema.id || 'neu'} aktion=${routing.aktion} ` +
    `experte=${routing.experte || '-'} confidence=${routing.confidence.toFixed(2)}` +
    (routing.hinweis ? ` (${routing.hinweis})` : ''));

  // 2) Faden auflösen — genau hier entstehen parallele Gesprächsfäden.
  let thema = routing.thema.id ? themen.ladeThema(chatId, routing.thema.id) : null;
  if (!thema) {
    thema = themen.erstelleThema(chatId, routing.thema.name || router.leiteThemaNamenAb(text));
  }

  // 3) Reine Datei-Ablage
  if (['vorlage_speichern', 'style_speichern', 'dokument_speichern'].includes(routing.aktion)) {
    if (datei && datei.buffer) {
      const abgelegt = legeDateiAb(chatId, datei, routing.aktion);
      if (abgelegt) return abgelegt;
    }
    return { text: routing.hinweis || 'Schick mir die Datei dazu, dann lege ich sie ab.' };
  }

  // 4) Rückfrage
  if (routing.aktion === 'nachfragen') {
    return { text: routing.hinweis || 'Kannst du mir dazu noch etwas mehr Kontext geben?' };
  }

  const experte = routing.aktion === 'verarbeiten' && routing.experte
    ? experten.findeExperteMitId(routing.experte)
    : null;

  // 5) Datei-Hook des Experten (z.B. Unterschrift-Foto ablegen)
  if (experte && datei && datei.buffer && typeof experte.onDatei === 'function') {
    const hook = await experte.onDatei({
      chatId, themaId: thema.id, buffer: datei.buffer,
      dateiName: datei.name, mimeType: datei.mimeType,
      beschriftung: text, dienste
    });
    if (hook) return hook;
  }

  if (experte) dienste.protokoll?.('Experte', `Aktiv: ${experte.id} (${chatId}/${thema.id})`);

  // 6) Ausführen — je nach Bauart des Experten
  const bauart = experten.art(experte);
  let ergebnis;

  if (bauart === 'Vorgang') {
    // Deklarativer Experte: der Motor sammelt, fragt nach und führt aus.
    ergebnis = await vorgangsmotor.verarbeite(
      { experte, chatId, themaId: thema.id, text, dokInhalt }, dienste);
  } else if (bauart === 'frei') {
    // Experte mit eigener Logik.
    try {
      ergebnis = await experte.verarbeite(
        { chatId, themaId: thema.id, text, dokInhalt, thema }, dienste);
    } catch (err) {
      dienste.protokoll?.('Fehler', `Experte ${experte.id} abgestürzt: ${err.message}`);
      ergebnis = { text: `Fehler im Modul ${experte.name}: ${err.message}` };
    }
  } else {
    // Prompt-Experte oder normaler Chat: Standard-Flow mit Tool-Loop.
    ergebnis = await standardAntwort({ chatId, thema, text, dokInhalt, experte }, dienste);
  }

  // 7) Nachbereitung: Gedächtnis, Filter, Persistenz
  const { sichtbar, fakt } = trenneMerkeHooks(ergebnis.text || '');
  let hinweis = '';
  if (fakt && gedaechtnis.fuegeHinzu(chatId, fakt)) hinweis = `\n\n_gemerkt: ${fakt}_`;

  const gefiltert = sicherheit.filterOutput(sichtbar);
  if (gefiltert.gefiltert.length > 0) {
    dienste.protokoll?.('Sicherheit',
      `Output-Filter entfernte ${gefiltert.gefiltert.length} Stelle(n) (${chatId}): ${gefiltert.gefiltert.join(', ')}`);
  }
  const endText = (gefiltert.hinweis ? gefiltert.hinweis + '\n\n' : '') +
    (gefiltert.text || '(keine Antwort)') + hinweis;

  themen.haengeNachrichtAn(chatId, thema.id, 'user', text || '(Datei)');
  themen.haengeNachrichtAn(chatId, thema.id, 'assistant', gefiltert.text || '');
  komprimiereSpaeter(chatId, thema.id, dienste);

  return {
    text: endText,
    dateien: ergebnis.dateien || [],
    knoepfe: ergebnis.knoepfe || [],
    themaId: thema.id
  };
}

// Standard-Chat mit Kontext und Tool-Loop.
async function standardAntwort({ chatId, thema, text, dokInhalt, experte }, dienste) {
  const systemPrompt = kontext.baueHauptSystemPrompt(
    gedaechtnis.ladeGedaechtnis(chatId),
    experte ? experte.systemPromptAdd : null
  );
  const messages = kontext.baueHauptMessages(thema, text, dokInhalt);
  const wz = werkzeuge.fuerExperte(experte, dienste.provider);
  const antwort = await toolloop.laufe({
    chatId, systemPrompt, messages, werkzeuge: wz, provider: dienste.provider, dienste
  });
  return { text: antwort };
}

// Bestätigen-Knopf eines Vorgangs (kommt vom Adapter zurück).
async function bestaetigeVorgang({ chatId, themaId }, dienste) {
  const vorgang = vorgangSpeicher.lade(chatId, themaId);
  if (!vorgang) return { text: 'Dieser Vorgang existiert nicht mehr.' };
  const experte = experten.findeExperteMitId(vorgang.experteId);
  if (!experte) return { text: 'Der zuständige Experte ist nicht mehr verfügbar.' };
  return vorgangsmotor.bestaetigeUeberKnopf({ experte, chatId, themaId }, dienste);
}

async function brichVorgangAb({ chatId, themaId }) {
  const weg = vorgangSpeicher.loesche(chatId, themaId);
  return { text: weg ? 'Vorgang verworfen.' : 'Es lief kein Vorgang mehr.' };
}

module.exports = { verarbeiteNachricht, bestaetigeVorgang, brichVorgangAb, _trenneMerkeHooks: trenneMerkeHooks };
