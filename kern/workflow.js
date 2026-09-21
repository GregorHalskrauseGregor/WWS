// Workflow — ein Multi-Command-Auftrag mit N Sub-Vorgängen.
//
// Vorher: 1 Nachricht -> 1 Router-Entscheidung -> 1 Experte -> 1 Antwort.
// Jetzt:  1 Nachricht -> 1 Router-Entscheidung (kann N Befehle enthalten)
//        -> 1 Workflow mit N Sub-Vorgängen -> sequenziell abgearbeitet.
//
// Beispiel: "Bestell 5 Kugelhähne, erstelle Aufmaß Badezimmer, suche Anleitung PE-Rohr"
// -> 1 Workflow mit 3 Sub-Vorgängen (grosshandel, materialaufmass, recherche).
// Der erste startet sofort, die anderen warten. Folge-Antworten des Users gehen
// automatisch an den Sub-Vorgang, der gerade auf Rückmeldung wartet.
//
// Storage: data/users/<chatId>/workflows/<workflowId>.json
//          data/users/<chatId>/workflows/workflows-index.json

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = require('../config').PFADE.USERS;
const WORKFLOW_ORDNER = 'workflows';
const INDEX_DATEINAME = 'workflows-index.json';

// Pfad-Injection verhindern — nur Ziffern + Minus (Telegram-IDs).
function sichereChatId(chatId) {
  const s = String(chatId);
  if (!/^-?\d{1,20}$/.test(s)) throw new Error('Ungültige chat-id: ' + s);
  return s;
}

function workflowOrdner(chatId) {
  return path.join(DATA_ROOT, sichereChatId(chatId), WORKFLOW_ORDNER);
}

function workflowPfad(chatId, workflowId) {
  return path.join(workflowOrdner(chatId), workflowId + '.json');
}

function indexPfad(chatId) {
  return path.join(workflowOrdner(chatId), INDEX_DATEINAME);
}

function stelleVerzeichnisseSicher(chatId) {
  fs.mkdirSync(workflowOrdner(chatId), { recursive: true });
}

function neueWorkflowId() {
  return 'wf-' + crypto.randomBytes(4).toString('hex');
}

function jetzt() {
  return new Date().toISOString();
}

function ladeIndex(chatId) {
  const p = indexPfad(chatId);
  if (!fs.existsSync(p)) return [];
  try {
    const daten = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(daten) ? daten : [];
  } catch (err) {
    throw new Error('Workflow-Index ist beschädigt: ' + err.message);
  }
}

function speichereIndex(chatId, index) {
  stelleVerzeichnisseSicher(chatId);
  fs.writeFileSync(indexPfad(chatId), JSON.stringify(index, null, 2), 'utf-8');
}

function lade(chatId, workflowId) {
  const p = workflowPfad(chatId, workflowId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    throw new Error(`Workflow ${workflowId} ist beschädigt: ${err.message}`);
  }
}

function speichere(workflow) {
  stelleVerzeichnisseSicher(workflow.chatId);
  workflow.letzteAenderung = jetzt();
  fs.writeFileSync(workflowPfad(workflow.chatId, workflow.id),
    JSON.stringify(workflow, null, 2), 'utf-8');
  // Index neu aufbauen — klein, also einfach komplett ersetzen.
  const altIndex = ladeIndex(workflow.chatId).filter((w) => w.id !== workflow.id);
  altIndex.unshift({
    id: workflow.id,
    status: workflow.status,
    erstelltAm: workflow.erstelltAm,
    aktiverBefehlIndex: workflow.aktiverBefehlIndex,
    anzahlBefehle: workflow.befehle.length,
    kurzTitel: kurzTitel(workflow)
  });
  speichereIndex(workflow.chatId, altIndex);
}

function loesche(chatId, workflowId) {
  const p = workflowPfad(chatId, workflowId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const index = ladeIndex(chatId).filter((w) => w.id !== workflowId);
  speichereIndex(chatId, index);
}

// Menschenlesbarer Titel fürs Index/UI.
function kurzTitel(workflow) {
  const msg = String(workflow.urspruenglicheNachricht || '').replace(/\s+/g, ' ').trim();
  if (!msg) return 'Workflow';
  return msg.length > 60 ? msg.slice(0, 57) + '...' : msg;
}

// Startet einen neuen Workflow aus einer Liste von Befehlen (vom Router).
// befehle: [{ experteId, hinweis?, dok_typ?, ... }]
// Der erste Befehl ist sofort "laufend", die anderen "wartet".
function start(chatId, urspruenglicheNachricht, befehle) {
  if (!Array.isArray(befehle) || befehle.length === 0) {
    throw new Error('Workflow braucht mindestens einen Befehl');
  }
  const jetzt_ = jetzt();
  const workflow = {
    id: neueWorkflowId(),
    chatId: sichereChatId(chatId),
    urspruenglicheNachricht,
    erstelltAm: jetzt_,
    letzteAenderung: jetzt_,
    status: 'laufend',
    aktiverBefehlIndex: 0,
    befehle: befehle.map((b, i) => ({
      index: i,
      experteId: b.experteId,
      hinweis: b.hinweis || null,
      dokTyp: b.dok_typ || null,
      themaId: null,           // wird vom Orchestrator gesetzt
      status: i === 0 ? 'laufend' : 'wartet',
      zwischenText: '',
      ergebnis: null,
      gestartetAm: i === 0 ? jetzt_ : null,
      abgeschlossenAm: null
    }))
  };
  speichere(workflow);
  return workflow;
}

// Findet den Workflow, der gerade auf User-Eingabe wartet.
// "wartet_auf_eingabe" = der aktive Sub-Vorgang hat eine Rückfrage gestellt.
// Wird vom Orchestrator genutzt um Folge-Nachrichten automatisch zuzuordnen.
function aktiverBefehl(chatId) {
  const index = ladeIndex(chatId);
  for (const eintrag of index) {
    if (eintrag.status !== 'laufend') continue;
    const wf = lade(chatId, eintrag.id);
    if (!wf) continue;
    const befehl = wf.befehle[wf.aktiverBefehlIndex];
    if (befehl && befehl.status === 'wartet_auf_eingabe') {
      return { workflow: wf, befehl };
    }
  }
  return null;
}

function alleLaufenden(chatId) {
  const index = ladeIndex(chatId);
  const raus = [];
  for (const eintrag of index) {
    if (eintrag.status !== 'laufend' && eintrag.status !== 'wartet_auf_eingabe') continue;
    const wf = lade(chatId, eintrag.id);
    if (wf) raus.push(wf);
  }
  return raus;
}

function aktualisiereBefehl(chatId, workflowId, befehlIndex, updates) {
  const wf = lade(chatId, workflowId);
  if (!wf) throw new Error(`Workflow ${workflowId} nicht gefunden`);
  const befehl = wf.befehle[befehlIndex];
  if (!befehl) throw new Error(`Befehl ${befehlIndex} in Workflow ${workflowId} nicht gefunden`);
  Object.assign(befehl, updates);
  speichere(wf);
  return befehl;
}

function setzeWartetAufEingabe(chatId, workflowId, befehlIndex) {
  return aktualisiereBefehl(chatId, workflowId, befehlIndex, {
    status: 'wartet_auf_eingabe'
  });
}

function setzeThema(chatId, workflowId, befehlIndex, themaId) {
  return aktualisiereBefehl(chatId, workflowId, befehlIndex, { themaId });
}

function setzeZwischenText(chatId, workflowId, befehlIndex, zwischenText) {
  return aktualisiereBefehl(chatId, workflowId, befehlIndex, { zwischenText });
}

// Markiert aktuellen Befehl als abgeschlossen und aktiviert den nächsten.
// Gibt den nächsten wartenden Befehl zurück, oder null wenn keiner mehr da ist
// (in dem Fall wird der Workflow-Status auf 'abgeschlossen' gesetzt).
function naechsterBefehl(chatId, workflowId) {
  const wf = lade(chatId, workflowId);
  if (!wf) return null;
  const aktueller = wf.befehle[wf.aktiverBefehlIndex];
  if (aktueller) {
    aktueller.status = 'abgeschlossen';
    aktueller.abgeschlossenAm = jetzt();
  }
  const naechster = wf.befehle.find((b) => b.status === 'wartet');
  if (!naechster) {
    wf.status = 'abgeschlossen';
    speichere(wf);
    return null;
  }
  naechster.status = 'laufend';
  naechster.gestartetAm = jetzt();
  wf.aktiverBefehlIndex = naechster.index;
  speichere(wf);
  return naechster;
}

function setzeStatus(chatId, workflowId, status) {
  const wf = lade(chatId, workflowId);
  if (!wf) return null;
  wf.status = status;
  speichere(wf);
  return wf;
}

function setzeErgebnis(chatId, workflowId, befehlIndex, ergebnis) {
  return aktualisiereBefehl(chatId, workflowId, befehlIndex, { ergebnis });
}

// Bricht nur den aktuellen Sub-Vorgang ab und springt zum nächsten.
// Der Workflow geht weiter, außer es war der letzte.
function ueberspringeAktuellenBefehl(chatId, workflowId) {
  return naechsterBefehl(chatId, workflowId);
}

module.exports = {
  start,
  lade,
  loesche,
  speichere,
  aktiverBefehl,
  alleLaufenden,
  aktualisiereBefehl,
  setzeWartetAufEingabe,
  setzeThema,
  setzeZwischenText,
  setzeErgebnis,
  naechsterBefehl,
  setzeStatus,
  ueberspringeAktuellenBefehl
};
