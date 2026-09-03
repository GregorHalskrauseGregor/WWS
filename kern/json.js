// Robustes Bergen von JSON aus KI-Antworten.
//
// Modelle liefern trotz klarer Anweisung gern "Hier ist das JSON:" davor, packen
// es in einen Markdown-Codeblock oder hängen einen Kommentar an. Diese Funktion
// holt das Objekt trotzdem heraus. Vorher gab es drei Kopien dieser Logik
// (router, materialaufmass, material_entnahme) — jetzt eine.

function extrahiere(roh) {
  if (!roh || typeof roh !== 'string') return null;

  const kandidaten = [];
  const md = roh.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (md) kandidaten.push(md[1].trim());

  // Balancierte Objekte von jeder öffnenden Klammer aus — das größte zuerst,
  // damit verschachtelte Objekte nicht abgeschnitten werden.
  for (let i = 0; i < roh.length; i++) {
    if (roh[i] !== '{') continue;
    let tiefe = 0, inString = false, escape = false;
    for (let j = i; j < roh.length; j++) {
      const c = roh[j];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') tiefe++;
      else if (c === '}') {
        tiefe--;
        if (tiefe === 0) { kandidaten.push(roh.slice(i, j + 1)); break; }
      }
    }
  }

  kandidaten.sort((a, b) => b.length - a.length);
  for (const k of kandidaten) {
    try {
      const o = JSON.parse(k);
      if (o && typeof o === 'object') return o;
    } catch { /* nächster Kandidat */ }
  }
  return null;
}

module.exports = { extrahiere };
