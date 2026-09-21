// Orchestrator -- der komplette Ablauf einer Nachricht, ohne jeden Telegram-Bezug.
//
// Vorher lag das in bot.js zwischen Transport, Commands und Experten-Sonderfaellen.
// Diese Datei kennt kein Telegram, keine Inline-Buttons und keinen einzigen
// Experten namentlich. Sie liefert ein neutrales Ergebnis, das ein Adapter
// rendert:
//
//   { text, dateien: [pfade], knoepfe: [{text, daten}] }
//
// Multi-Command: Eine Nachricht kann N Befehle enthalten, die dann als
// Workflow (kern/workflow.js) sequenziell abgearbeitet werden. Folge-Nachrichten
// des Users werden automatisch dem Sub-Vorgang zugeordnet, der gerade auf
// Rueckmeldung wartet.

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
const wissensbasis = require('../lib/wissen');
const vorgangSpeicher = require('./vorgang');
const vorgangsmotor = require('./vorgangsmotor');
const werkzeuge = require('./werkzeuge');
const toolloop = require('./toolloop');
const workflow = require('./workflow');

// Der Hinweis aufs Aufraeumen kommt hoechstens einmal je Chat und Laufzeit.
const _korbHinweisGegeben = new Set();

// ────────────────────────────────────────────────────────────────── Helfer

// [MERKE: ...]-Zeilen aus der KI-Antwort schneiden.
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
  return { text: `OK ${ziel.was} gespeichert als \`${name}\` unter \`${ziel.wo}\`.` };
}

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

// ──────────────────────────────────────────────────────── Kern: ein Befehl
//
// Verarbeitet einen einzelnen Befehl. Wird sowohl vom Single-Command-Pfad
// (verarbeiteNachricht) als auch von den Workflow-Sub-Vorgaengen
// (verarbeiteWorkflowFolge, starteWorkflowAusRouting) aufgerufen.

async function verarbeiteBefehl(routing, params, dienste) {
  const { chatId, text, dokInhalt, dokInfo, datei } = params;
  dienste.protokoll?.('Router',
    `thema=${routing.thema.id || 'neu'} aktion=${routing.aktion} ` +
    `experte=${routing.experte || '-'} confidence=${routing.confidence.toFixed(2)}` +
    (routing.hinweis ? ` (${routing.hinweis})` : ''));

  let thema = routing.thema.id ? themen.ladeThema(chatId, routing.thema.id) : null;
  if (!thema) {
    thema = themen.erstelleThema(chatId, routing.thema.name || router.leiteThemaNamenAb(text));
  }

  const beende = (antwort) => {
    themen.haengeNachrichtAn(chatId, thema.id, 'user', text || '(Datei)');
    themen.haengeNachrichtAn(chatId, thema.id, 'assistant', antwort);
    return { text: antwort, themaId: thema.id };
  };

  if (['vorlage_speichern', 'style_speichern', 'dokument_speichern'].includes(routing.aktion)) {
    if (datei && datei.buffer) {
      const abgelegt = legeDateiAb(chatId, datei, routing.aktion);
      if (abgelegt) return beende(abgelegt.text);
    }
    return beende(routing.hinweis || 'Schick mir die Datei dazu, dann lege ich sie ab.');
  }

  if (routing.aktion === 'nachfragen') {
    return beende(routing.hinweis || 'Kannst du mir dazu noch etwas mehr Kontext geben?');
  }

  const experte = routing.aktion === 'verarbeiten' && routing.experte
    ? experten.findeExperteMitId(routing.experte)
    : null;

  if (experte && datei && datei.buffer && typeof experte.onDatei === 'function') {
    const hook = await experte.onDatei({
      chatId, themaId: thema.id, buffer: datei.buffer,
      dateiName: datei.name, mimeType: datei.mimeType,
      beschriftung: text, dienste
    });
    if (hook) return hook;
  }

  if (experte) dienste.protokoll?.('Experte', `Aktiv: ${experte.id} (${chatId}/${thema.id})`);

  const alleGefordert = wissensbasis.brauchtAlles(chatId);
  const wissensText = alleGefordert ? wissensbasis.alles() : wissensbasis.text(routing.wissen);
  if (wissensText) {
    dienste.protokoll?.('Wissen', alleGefordert
      ? `komplette Wissensbasis (${wissensText.length} Zeichen, /addAllK)`
      : `Karten: ${routing.wissen.join(', ')} (${wissensText.length} Zeichen)`);
  }

  const bauart = experten.art(experte);
  let ergebnis;

  if (bauart === 'Vorgang') {
    ergebnis = await vorgangsmotor.verarbeite(
      { experte, chatId, themaId: thema.id, text, dokInhalt, wissensText }, dienste);
  } else if (bauart === 'frei') {
    try {
      // dokInfo und datei MUESSEN mit: ohne sie sieht ein freier Experte nur
      // den ausgelesenen Text, nie den Dateinamen und nie den Puffer. Der
      // Projektordner konnte dadurch keine Originaldatei ablegen — und damit
      // spaeter auch keine zurueckgeben.
      ergebnis = await experte.verarbeite(
        { chatId, themaId: thema.id, text, dokInhalt, dokInfo, datei, thema, wissensText }, dienste);
    } catch (err) {
      dienste.protokoll?.('Fehler', `Experte ${experte.id} abgestuerzt: ${err.message}`);
      ergebnis = { text: `Fehler im Modul ${experte.name}: ${err.message}` };
    }
  } else {
    ergebnis = await standardAntwort({ chatId, thema, text, dokInhalt, experte, wissensText }, dienste);
  }

  const { sichtbar, fakt } = trenneMerkeHooks(ergebnis.text || '');
  let hinweis = '';
  if (fakt && gedaechtnis.fuegeHinzu(chatId, fakt)) hinweis = `\n\n_gemerkt: ${fakt}_`;

  const gefiltert = sicherheit.filterOutput(sichtbar);
  if (gefiltert.gefiltert.length > 0) {
    dienste.protokoll?.('Sicherheit',
      `Output-Filter entfernte ${gefiltert.gefiltert.length} Stelle(n) (${chatId}): ${gefiltert.gefiltert.join(', ')}`);
  }
  let korbHinweis = '';
  if (wissensText && !_korbHinweisGegeben.has(String(chatId))) {
    const korb = wissensbasis.korbVoll();
    if (korb.zuVoll) {
      _korbHinweisGegeben.add(String(chatId));
      korbHinweis = `\n\n_In der Wissensbank warten ${korb.anzahl} Notizen aufs Einordnen. ` +
        'Sie fahren derzeit bei jeder Materialnachricht ungefiltert mit -- /addKnowledge raeumt auf._';
    }
  }

  const endText = (gefiltert.hinweis ? gefiltert.hinweis + '\n\n' : '') +
    (gefiltert.text || '(keine Antwort)') + hinweis + korbHinweis;

  themen.haengeNachrichtAn(chatId, thema.id, 'user', text || '(Datei)');
  themen.haengeNachrichtAn(chatId, thema.id, 'assistant', gefiltert.text || '');
  komprimiereSpaeter(chatId, thema.id, dienste);

  return {
    text: endText,
    dateien: ergebnis.dateien || [],
    knoepfe: ergebnis.knoepfe || [],
    themaId: thema.id,
    // Workflow-Hooks: der Vorgangsmotor setzt diese Flags damit der Orchestrator
    // weiss, ob der Sub-Vorgang auf Eingabe wartet oder abgeschlossen ist.
    wartetAufEingabe: ergebnis.wartetAufEingabe === true || ergebnis.vorgangEnde === false,
    vorgangVollstaendig: ergebnis.vorgangVollstaendig === true || ergebnis.vorgangEnde === true,
    experteId: experte ? experte.id : null
  };
}

// Standard-Chat mit Kontext und Tool-Loop.
async function standardAntwort({ chatId, thema, text, dokInhalt, experte, wissensText }, dienste) {
  const zusatz = [experte ? experte.systemPromptAdd : null, wissensText]
    .filter(Boolean).join('\n\n');
  const systemPrompt = kontext.baueHauptSystemPrompt(
    gedaechtnis.ladeGedaechtnis(chatId),
    zusatz || null
  );
  const messages = kontext.baueHauptMessages(thema, text, dokInhalt);
  const wz = werkzeuge.fuerExperte(experte, dienste.provider, { chatId, themaId: thema.id });
  const antwort = await toolloop.laufe({
    chatId, systemPrompt, messages, werkzeuge: wz, provider: dienste.provider, dienste
  });
  return { text: antwort };
}

// ─────────────────────────────────────────────────────────────── Workflows

// Folge-Nachricht fuer einen offenen Workflow-Sub-Vorgang.
// Der Bot hat beim letzten Schritt eine Rueckfrage gestellt -- diese Nachricht
// ist die Antwort. Der Router wird bewusst umgangen, weil die Antwort
// semantisch zum Sub-Vorgang gehoert, nicht zur freien Erkennung.
async function verarbeiteWorkflowFolge(aktiverSub, params, dienste) {
  const { workflow: wf, befehl } = aktiverSub;
  const { chatId } = params;
  dienste.protokoll?.('Workflow',
    `Folge fuer ${wf.id}/${befehl.experteId} (Befehl ${befehl.index + 1}/${wf.befehle.length})`);

  const routing = {
    thema: { id: befehl.themaId, neu: false, name: null },
    aktion: 'verarbeiten',
    experte: befehl.experteId,
    dokTyp: befehl.dokTyp,
    hinweis: null,
    confidence: 1,
    wissen: [],
    weitere_befehle: []
  };

  const ergebnis = await verarbeiteBefehl(routing, params, dienste);

  if (ergebnis.wartetAufEingabe) {
    workflow.setzeWartetAufEingabe(chatId, wf.id, befehl.index);
    return { text: ergebnis.text, dateien: ergebnis.dateien, knoepfe: ergebnis.knoepfe };
  }

  const naechster = workflow.naechsterBefehl(chatId, wf.id);
  if (!naechster) {
    dienste.protokoll?.('Workflow', wf.id + ': alle Befehle abgeschlossen');
    return {
      text: `Befehl ${befehl.index + 1}/${wf.befehle.length} abgeschlossen.\n\n` +
            `Workflow abgeschlossen (${wf.befehle.length} Aufgaben erledigt).`,
      dateien: ergebnis.dateien,
      knoepfe: ergebnis.knoepfe
    };
  }
  dienste.protokoll?.('Workflow',
    `${wf.id}: Befehl ${befehl.index + 1} abgeschlossen, weiter mit ` +
    `${naechster.experteId} (${naechster.index + 1}/${wf.befehle.length})`);
  return {
    text: `Befehl ${befehl.index + 1}/${wf.befehle.length} abgeschlossen.\n\n` +
          ergebnis.text +
          `\n\nNaechster Schritt: ${naechster.experteId} (${naechster.index + 1}/${wf.befehle.length}) ` +
          `-- schick einfach deine Antwort.`,
    dateien: ergebnis.dateien,
    knoepfe: ergebnis.knoepfe
  };
}

// Startet einen Workflow aus einem Multi-Intent-Routing. Der erste Befehl wird
// direkt verarbeitet, die anderen warten auf "ihren" Schritt.
async function starteWorkflowAusRouting(routing, params, dienste) {
  const { chatId, text } = params;
  const alleBefehle = [routing, ...routing.weitere_befehle];
  dienste.protokoll?.('Workflow',
    `Starte Workflow mit ${alleBefehle.length} Befehlen: ` +
    alleBefehle.map((b) => b.experte || b.aktion).join(', '));

  const befehleFuerSpeicher = alleBefehle.map((b) => ({
    experteId: b.experte,
    hinweis: b.hinweis,
    dokTyp: b.dok_typ
  }));
  const wf = workflow.start(chatId, text, befehleFuerSpeicher);
  dienste.protokoll?.('Workflow', `Workflow ${wf.id} gestartet`);

  const ergebnis = await verarbeiteBefehl(routing, params, dienste);

  if (ergebnis.wartetAufEingabe) {
    workflow.setzeWartetAufEingabe(chatId, wf.id, 0);
    return { text: ergebnis.text, dateien: ergebnis.dateien, knoepfe: ergebnis.knoepfe };
  }
  const naechster = workflow.naechsterBefehl(chatId, wf.id);
  if (!naechster) {
    return {
      text: `Workflow abgeschlossen (${wf.befehle.length} Aufgaben erledigt).\n\n` + ergebnis.text,
      dateien: ergebnis.dateien,
      knoepfe: ergebnis.knoepfe
    };
  }
  return {
    text: `Befehl 1/${wf.befehle.length} abgeschlossen.\n\n` +
          ergebnis.text +
          `\n\nNaechster Schritt: ${naechster.experteId} (2/${wf.befehle.length}) ` +
          `-- schick einfach deine Antwort.`,
    dateien: ergebnis.dateien,
    knoepfe: ergebnis.knoepfe
  };
}

// ──────────────────────────────────────────────────────────── Hauptablauf

async function verarbeiteNachricht({ chatId, text, dokInhalt = '', dokInfo = null, datei = null }, dienste) {
  // 0) Limit vor allem anderen.
  const limit = ratelimit.pruefeNachricht(chatId);
  if (!limit.ok) {
    dienste.protokoll?.('Sicherheit', `Rate-Limit blockt ${chatId}: ${limit.grund}`);
    return { text: 'STOP ' + limit.grund };
  }
  ratelimit.zaehleNachricht(chatId);

  // 1) WORKFLOW-FOLGE: gibt es einen Sub-Vorgang der auf User-Eingabe wartet?
  // Wenn ja, geht die Nachricht direkt dorthin -- der Router wird uebersprungen.
  const aktiverSub = workflow.aktiverBefehl(chatId);
  if (aktiverSub) {
    return await verarbeiteWorkflowFolge(aktiverSub,
      { chatId, text, dokInhalt, dokInfo, datei }, dienste);
  }

  // 2) Router: ein oder mehrere Befehle erkennen.
  const routing = await router.entscheide({
    text, dokInfo, chatId, chat: dienste.routerChat, protokoll: dienste.protokoll
  });
  dienste.protokoll?.('Router',
    `thema=${routing.thema.id || 'neu'} aktion=${routing.aktion} ` +
    `experte=${routing.experte || '-'} confidence=${routing.confidence.toFixed(2)}` +
    (routing.hinweis ? ` (${routing.hinweis})` : '') +
    (routing.weitere_befehle?.length ? ` +${routing.weitere_befehle.length} Folge-Befehle` : ''));

  // 3) WORKFLOW-START: Multi-Intent erkannt -> Workflow anlegen und ersten
  // Sub-Vorgang direkt verarbeiten.
  if (routing.weitere_befehle && routing.weitere_befehle.length > 0) {
    return await starteWorkflowAusRouting(routing,
      { chatId, text, dokInhalt, dokInfo, datei }, dienste);
  }

  // 4) SINGLE-COMMAND (alter Pfad, ueber verarbeiteBefehl).
  return await verarbeiteBefehl(routing, { chatId, text, dokInhalt, dokInfo, datei }, dienste);
}

// Bestätigen-Knopf eines Vorgangs.
async function bestaetigeVorgang({ chatId, themaId }, dienste) {
  const vorgang = vorgangSpeicher.lade(chatId, themaId);
  if (!vorgang) return { text: 'Dieser Vorgang existiert nicht mehr.' };
  const experte = experten.findeExperteMitId(vorgang.experteId);
  if (!experte) return { text: 'Der zustaendige Experte ist nicht mehr verfuegbar.' };
  return vorgangsmotor.bestaetigeUeberKnopf({ experte, chatId, themaId }, dienste);
}

async function brichVorgangAb({ chatId, themaId }) {
  const weg = vorgangSpeicher.loesche(chatId, themaId);
  return { text: weg ? 'Vorgang verworfen.' : 'Es lief kein Vorgang mehr.' };
}

module.exports = { verarbeiteNachricht, bestaetigeVorgang, brichVorgangAb, _trenneMerkeHooks: trenneMerkeHooks };
