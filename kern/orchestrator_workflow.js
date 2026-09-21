// Workflow-Logik für den Orchestrator.
// Ausgelagert aus kern/orchestrator.js damit der Haupt-Orchester-Code lesbar
// bleibt — diese Datei enthält nur die Funktionen, die mit Workflows zu tun
// haben (verarbeiteBefehl, verarbeiteWorkflowFolge, starteWorkflowAusRouting).

// Kernlogik: einen einzelnen Befehl verarbeiten (Single-Command oder Workflow-Sub).
// Wird sowohl von verarbeiteNachricht als auch von verarbeiteWorkflowFolge aufgerufen.
async function verarbeiteBefehl(routing, params, dienste) {
  const { chatId, text, dokInhalt, dokInfo, datei } = params;
  let thema = routing.thema.id ? themen.ladeThema(chatId, routing.thema.id) : null;
  if (!thema) {
    thema = themen.erstelleThema(chatId, routing.thema.name || router.leiteThemaNamenAb(text));
  }

  // Auch kurze Zwischenschritte kommen in den Verlauf.
  const beende = (antwort) => {
    themen.haengeNachrichtAn(chatId, thema.id, 'user', text || '(Datei)');
    themen.haengeNachrichtAn(chatId, thema.id, 'assistant', antwort);
    return { text: antwort, themaId: thema.id };
  };

  // 3) Reine Datei-Ablage
  if (['vorlage_speichern', 'style_speichern', 'dokument_speichern'].includes(routing.aktion)) {
    if (datei && datei.buffer) {
      const abgelegt = legeDateiAb(chatId, datei, routing.aktion);
      if (abgelegt) return beende(abgelegt.text);
    }
    return beende(routing.hinweis || 'Schick mir die Datei dazu, dann lege ich sie ab.');
  }

  // 4) Rueckfrage
  if (routing.aktion === 'nachfragen') {
    return beende(routing.hinweis || 'Kannst du mir dazu noch etwas mehr Kontext geben?');
  }

  const experte = routing.aktion === 'verarbeiten' && routing.experte
    ? experten.findeExperteMitId(routing.experte)
    : null;

  // 5) Datei-Hook des Experten
  if (experte && datei && datei.buffer && typeof experte.onDatei === 'function') {
    const hook = await experte.onDatei({
      chatId, themaId: thema.id, buffer: datei.buffer,
      dateiName: datei.name, mimeType: datei.mimeType,
      beschriftung: text, dienste
    });
    if (hook) return hook;
  }

  if (experte) dienste.protokoll?.('Experte', `Aktiv: ${experte.id} (${chatId}/${thema.id})`);

  // 6) Wissen bereitstellen
  const alleGefordert = wissensbasis.brauchtAlles(chatId);
  const wissensText = alleGefordert ? wissensbasis.alles() : wissensbasis.text(routing.wissen);
  if (wissensText) {
    dienste.protokoll?.('Wissen', alleGefordert
      ? `komplette Wissensbasis (${wissensText.length} Zeichen, /addAllK)`
      : `Karten: ${routing.wissen.join(', ')} (${wissensText.length} Zeichen)`);
  }

  // 7) Ausfuehren
  const bauart = experten.art(experte);
  let ergebnis;

  if (bauart === 'Vorgang') {
    ergebnis = await vorgangsmotor.verarbeite(
      { experte, chatId, themaId: thema.id, text, dokInhalt, wissensText }, dienste);
  } else if (bauart === 'frei') {
    try {
      ergebnis = await experte.verarbeite(
        { chatId, themaId: thema.id, text, dokInhalt, thema, wissensText }, dienste);
    } catch (err) {
      dienste.protokoll?.('Fehler', `Experte ${experte.id} abgestuerzt: ${err.message}`);
      ergebnis = { text: `Fehler im Modul ${experte.name}: ${err.message}` };
    }
  } else {
    ergebnis = await standardAntwort({ chatId, thema, text, dokInhalt, experte, wissensText }, dienste);
  }

  // 8) Nachbereitung
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
      korbHinweis = '\n\n_In der Wissensbank warten ' + korb.anzahl + ' Notizen aufs Einordnen. ' +
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
    // Workflow-Hooks
    wartetAufEingabe: ergebnis.wartetAufEingabe === true || ergebnis.vorgangEnde === false,
    vorgangVollstaendig: ergebnis.vorgangVollstaendig === true || ergebnis.vorgangEnde === true,
    experteId: experte ? experte.id : null
  };
}

// Folge-Nachricht fuer einen offenen Workflow-Sub-Vorgang.
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
      text: 'Befehl ' + (befehl.index + 1) + '/' + wf.befehle.length + ' abgeschlossen.\n\n' +
            'Workflow abgeschlossen (' + wf.befehle.length + ' Aufgaben erledigt).',
      dateien: ergebnis.dateien,
      knoepfe: ergebnis.knoepfe
    };
  }
  dienste.protokoll?.('Workflow',
    wf.id + ': Befehl ' + (befehl.index + 1) + ' abgeschlossen, weiter mit ' +
    naechster.experteId + ' (' + (naechster.index + 1) + '/' + wf.befehle.length + ')');
  return {
    text: 'Befehl ' + (befehl.index + 1) + '/' + wf.befehle.length + ' abgeschlossen.\n\n' +
          ergebnis.text +
          '\n\nNaechster Schritt: ' + naechster.experteId + ' (' + (naechster.index + 1) + '/' +
          wf.befehle.length + ') -- schick einfach deine Antwort.',
    dateien: ergebnis.dateien,
    knoepfe: ergebnis.knoepfe
  };
}

// Startet einen Workflow aus einem Multi-Intent-Routing.
async function starteWorkflowAusRouting(routing, params, dienste) {
  const { chatId, text } = params;
  const alleBefehle = [routing, ...routing.weitere_befehle];
  dienste.protokoll?.('Workflow',
    'Starte Workflow mit ' + alleBefehle.length + ' Befehlen: ' +
    alleBefehle.map((b) => b.experte || b.aktion).join(', '));

  const befehleFuerSpeicher = alleBefehle.map((b) => ({
    experteId: b.experte,
    hinweis: b.hinweis,
    dokTyp: b.dok_typ
  }));
  const wf = workflow.start(chatId, text, befehleFuerSpeicher);
  dienste.protokoll?.('Workflow', 'Workflow ' + wf.id + ' gestartet');

  const ergebnis = await verarbeiteBefehl(routing, params, dienste);

  if (ergebnis.wartetAufEingabe) {
    workflow.setzeWartetAufEingabe(chatId, wf.id, 0);
    return { text: ergebnis.text, dateien: ergebnis.dateien, knoepfe: ergebnis.knoepfe };
  }
  const naechster = workflow.naechsterBefehl(chatId, wf.id);
  if (!naechster) {
    return {
      text: 'Workflow abgeschlossen (' + wf.befehle.length + ' Aufgaben erledigt).\n\n' + ergebnis.text,
      dateien: ergebnis.dateien,
      knoepfe: ergebnis.knoepfe
    };
  }
  return {
    text: 'Befehl 1/' + wf.befehle.length + ' abgeschlossen.\n\n' +
          ergebnis.text +
          '\n\nNaechster Schritt: ' + naechster.experteId + ' (2/' + wf.befehle.length +
          ') -- schick einfach deine Antwort.',
    dateien: ergebnis.dateien,
    knoepfe: ergebnis.knoepfe
  };
}

module.exports = { verarbeiteBefehl, verarbeiteWorkflowFolge, starteWorkflowAusRouting };
