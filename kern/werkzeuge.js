// Werkzeug-Registry: führt die globalen Tools (Web-Suche, URL-Lesen) mit den
// Tools zusammen, die ein Experte selbst mitbringt.
//
// Damit wird das erfüllt, was vorher nur dokumentiert war: das Feld "tools"
// am Experten wurde nie ausgelesen — jeder Experte bekam immer dieselben
// Web-Tools. Jetzt kann z.B. die Bestellung ein eigenes "bestand_pruefen"
// anbieten, das die KI im Gespräch aufrufen darf.

const globaleTools = require('../tools');

function expertenDefinition(t) {
  return {
    name: t.name,
    description: t.beschreibung || t.description || '',
    input_schema: t.parameter || { type: 'object', properties: {} }
  };
}

// Liefert Definitionen + Executor für den aktuellen Kontext.
function fuerExperte(experte, provider) {
  const eigene = (experte && experte.tools) || [];
  const nurEigene = experte && experte.nurEigeneTools === true;

  const definitionen = [
    ...(nurEigene ? [] : globaleTools.verfuegbareTools(provider)),
    ...eigene.map(expertenDefinition)
  ];

  async function ausfuehren(name, args) {
    const eigen = eigene.find((t) => t.name === name);
    if (eigen) {
      try {
        const roh = await eigen.ausfuehren(args || {});
        return typeof roh === 'string' ? roh : JSON.stringify(roh);
      } catch (err) {
        return `Fehler im Werkzeug ${name}: ${err.message}`;
      }
    }
    return globaleTools.fuehreToolAus(name, args);
  }

  return { definitionen, ausfuehren };
}

module.exports = { fuerExperte };
