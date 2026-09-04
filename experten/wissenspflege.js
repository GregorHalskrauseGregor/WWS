// 🧠 Wissenspflege — freier Experte fuer die Wissensbasis.
//
// Heisst bewusst NICHT "wissen": der Kern fuehrt inzwischen selbst ein Feld
// namens "wissen" (die Kartenauswahl des Routers), und ein Test verbietet, dass
// im Kern ein Expertenname faellt. Ein zu generischer Experten-Name kollidiert
// frueher oder spaeter mit einem Feldnamen.
//
// Die Wissensbasis hat zwei Ebenen, und dieser Experte ist die Bruecke dazwischen:
//
//   wissen/Wissensbank.md   Eingangskorb. Chronologisch, unsortiert, formlos.
//                           Hier landet alles, was Torsten dem Bot beibringt —
//                           per Chat ("merk dir, eine Stange Kupfer sind 5 m")
//                           oder von Hand mit dem Texteditor.
//   wissen/karten/*.md      Aufgeraeumtes Wissen. Nur diese Karten koennen
//                           gezielt in einen Prompt geladen werden.
//
// Der Weg vom Korb in die Karten laeuft ueber /addKnowledge und wird von der KI
// vorgeschlagen, aber nie ohne Bestaetigung ausgefuehrt. Grund: eine falsch
// einsortierte Zeile ist schlimmer als eine unsortierte — sie wird kuenftig in
// Prompts geladen, in denen sie nichts zu suchen hat, und faellt niemandem auf.

const wissen = require('../lib/wissen');
const { extrahiere } = require('../kern/json');

// Vorschlaege zwischen "/addKnowledge" und "/addKnowledge ja". Nur im Speicher:
// ein Vorschlag, den man eine Stunde spaeter bestaetigt, passt womoeglich nicht
// mehr zu einer inzwischen veraenderten Wissensbank.
const _vorschlaege = new Map();

function kartenUebersicht() {
  return wissen.karten()
    .map((k) => `- ${k.id} („${k.titel}“) — geladen wenn: ${k.wann}`)
    .join('\n');
}

function baueEinordnungsPrompt(offene) {
  return `Du ordnest lose Wissensnotizen eines SHK-Handwerkers in eine Wissensbasis ein.

VORHANDENE KARTEN:
${kartenUebersicht()}

ZU EINORDNENDE NOTIZEN (mit ihrer Nummer):
${offene.map((o) => `[${o.nr}] ${o.satz}`).join('\n')}

REGELN:
- Ordne jede Notiz genau EINER Karte zu, wenn sie fachlich dort hingehoert.
- Schreib den Absatz so um, dass er in die Karte passt: knapp, im Ton der Karte,
  als Fakt formuliert. Keine Anrede, kein "der Nutzer sagt".
- Passt eine Notiz in keine Karte, schlag eine NEUE Karte vor. Eine neue Karte
  braucht zwingend einen "wann"-Satz, der beschreibt, bei welcher Art von
  Nachricht sie geladen werden soll. Ohne den ist sie totes Gewicht.
- Lege eine neue Karte nur an, wenn ein eigenes Thema erkennbar ist, nicht fuer
  eine einzelne Zeile, die auch in eine bestehende Karte passt.
- Ist eine Notiz keine Fachinformation (Frage, Gedanke, Erinnerung an dich
  selbst), lass sie weg. Sie bleibt dann offen stehen.

ANTWORT: ausschliesslich ein JSON-Objekt, kein Markdown, kein Kommentar.

{"zuordnungen":[{"nr":<nummer>,"karte":"<kartenId>","absatz":"<Text fuer die Karte>"}],
 "neue_karten":[{"id":"<kurz_klein>","titel":"<Titel>","wann":"<wann laden>","inhalt":"<Text>","nrs":[<nummern>]}]}`;
}

async function schlageEinordnungVor(chatId, dienste) {
  const offene = wissen.offeneEintraege();
  if (!offene.length) {
    return { text: '📚 In der Wissensbank steht nichts Offenes. Alles eingeordnet.' };
  }

  const roh = await dienste.chat(baueEinordnungsPrompt(offene), 'Ordne die Notizen ein.');
  const plan = extrahiere(roh);
  if (!plan) {
    return { text: 'Ich konnte die Einordnung nicht lesen. Versuch es nochmal mit /addKnowledge.' };
  }

  const zuordnungen = Array.isArray(plan.zuordnungen) ? plan.zuordnungen : [];
  const neue = Array.isArray(plan.neue_karten) ? plan.neue_karten : [];
  if (!zuordnungen.length && !neue.length) {
    return {
      text: `📚 ${offene.length} offene Notiz(en), aber keine davon ist eine Fachinformation, ` +
        'die in eine Karte gehört. Sie bleiben stehen.'
    };
  }

  _vorschlaege.set(String(chatId), { plan, gestelltAm: Date.now() });

  const zeilen = ['📚 *Vorschlag zur Einordnung*', ''];
  for (const z of zuordnungen) {
    const k = wissen.karte(z.karte);
    zeilen.push(`→ *${k ? k.titel : z.karte}*`);
    zeilen.push(`   ${z.absatz}`);
  }
  for (const n of neue) {
    zeilen.push(`🆕 *Neue Karte: ${n.titel}*`);
    zeilen.push(`   _geladen wenn: ${n.wann}_`);
    zeilen.push(`   ${n.inhalt}`);
  }
  zeilen.push('', 'Passt das? Dann `/addKnowledge ja`. Sonst schreib die Zeilen in der Wissensbank um.');
  return { text: zeilen.join('\n') };
}

function fuehreEinordnungAus(chatId) {
  const eintrag = _vorschlaege.get(String(chatId));
  if (!eintrag) return { text: 'Es liegt kein Vorschlag vor. Schick erst /addKnowledge.' };
  _vorschlaege.delete(String(chatId));

  const { plan } = eintrag;
  const abgehakt = [];
  let geschrieben = 0;

  for (const z of (plan.zuordnungen || [])) {
    if (wissen.ergaenzeKarte(z.karte, z.absatz)) {
      geschrieben++;
      abgehakt.push({ nr: z.nr, karte: z.karte });
    }
  }
  for (const n of (plan.neue_karten || [])) {
    const id = wissen.legeKarteAn(n.id, n.titel, n.wann, n.inhalt);
    if (!id) continue;
    geschrieben++;
    for (const nr of (n.nrs || [])) abgehakt.push({ nr, karte: id });
  }

  const haken = wissen.hakeAb(abgehakt);
  return {
    text: `✅ ${geschrieben} Einträge in die Wissenskarten geschrieben, ${haken} Zeile(n) in der ` +
      'Wissensbank abgehakt. Sie bleiben als Verlauf stehen.'
  };
}

module.exports = {
  id: 'wissenspflege',
  name: 'Wissenspflege',
  emoji: '🧠',
  beschreibung: 'Nimmt Fachwissen entgegen und legt es in der Wissensbank ab — Umgangssprache, ' +
    'Gebindegrößen, Maße, Zulassungen, was bei welchem Artikel gefragt werden muss.',

  zustaendigWenn:
    'Der Nutzer will dem Bot etwas BEIBRINGEN statt etwas zu buchen: "merk dir", ' +
    '"bei uns heißt das", "eine Stange Kupfer sind 5 Meter", "trag in die Wissensbank ein", ' +
    'oder er fragt, was der Bot über Material weiß. NICHT zuständig, wenn Material ' +
    'ein- oder ausgebucht werden soll — das ist der Lager-Experte.',

  implementiert: true,

  // Freier Experte: eine Notiz aufzunehmen braucht kein Sammeln über mehrere
  // Nachrichten. Der Satz steht schon da, er muss nur in den Korb.
  async verarbeite({ chatId, text }) {
    const satz = String(text || '').trim();
    if (!satz) return { text: 'Was soll ich mir merken?' };

    if (/^(was wei(ß|ss)t du|zeig|welche karten|wissensbasis|wissensbank)/i.test(satz)) {
      return uebersicht();
    }

    wissen.notiere(satz, `Chat ${chatId}`);
    const offen = wissen.offeneEintraege().length;
    return {
      text: '🧠 Notiert in der Wissensbank.\n\n' +
        `_${offen} Notiz(en) warten auf die Einordnung. Mit /addKnowledge sortiere ich sie in die Karten._`
    };
  },

  commands: [
    {
      name: 'addKnowledge',
      beschreibung: 'Ordnet die offenen Notizen der Wissensbank in die Wissenskarten ein',
      ausfuehren: async ({ chatId, argument, dienste }) => {
        if (argument && /^(ja|ok|passt|mach)/i.test(argument.trim())) {
          return fuehreEinordnungAus(chatId);
        }
        wissen.neuLaden();
        return schlageEinordnungVor(chatId, dienste);
      }
    },
    {
      name: 'addAllK',
      beschreibung: 'Lädt für die nächste Nachricht die komplette Wissensbasis',
      ausfuehren: async ({ chatId }) => {
        wissen.merkeAllesFuer(chatId);
        const gesamt = wissen.alles().length;
        return {
          text: '📚 Für deine *nächste* Nachricht schicke ich die komplette Wissensbasis mit ' +
            `(${Math.round(gesamt / 3.2)} Tokens statt der üblichen zwei bis drei Karten).\n\n` +
            '_Gilt nur für eine Nachricht, danach entscheidet wieder der Router._'
        };
      }
    },
    {
      name: 'wissen',
      beschreibung: 'Zeigt, was der Bot über SHK-Material weiß',
      ausfuehren: async () => { wissen.neuLaden(); return uebersicht(); }
    }
  ]
};

function uebersicht() {
  const karten = wissen.karten();
  const offen = wissen.offeneEintraege();
  const zeilen = [
    '🧠 *Wissensbasis*',
    '',
    `*${karten.length} Karten* (Ordner \`wissen/karten/\`, ganz normale Markdown-Dateien):`
  ];
  for (const k of karten) {
    zeilen.push(`• *${k.titel}* — ${Math.round(k.zeichen / 3.2)} Tokens`);
    zeilen.push(`  _geladen wenn: ${k.wann}_`);
  }
  zeilen.push('');
  zeilen.push(offen.length
    ? `*Wissensbank:* ${offen.length} Notiz(en) noch nicht eingeordnet → /addKnowledge`
    : '*Wissensbank:* alles eingeordnet.');
  zeilen.push('');
  zeilen.push('_Der Router wählt pro Nachricht, welche Karten mitgehen. /addAllK schickt einmalig alle._');
  return { text: zeilen.join('\n') };
}
