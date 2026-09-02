// Pro-User-Rate-Limiting. Schutz vor Kostenexplosion, falls jemand den Bot
// mit Anfragen flutet, und vor automatisierten Angriffen.
//
// Pro Chat-ID wird gezählt:
//   - Nachrichten pro Stunde
//   - Nachrichten pro Tag
//   - Tool-Aufrufe pro Tag
//
// Überschreitung: höfliche Meldung statt Verarbeitung. Bei Tool-Limit: Bot
// arbeitet ohne Tools weiter (User merkt, dass grad keine Web-Recherche geht).
//
// State liegt in data/users/<chatId>/rate.json (volume-fest, geht nicht
// bei Redeploy verloren).

const fs = require('fs');
const path = require('path');

const LIMITS = {
  msgsPerHour: 30,
  msgsPerDay: 200,
  toolCallsPerDay: 60
};

function userVerzeichnis(chatId) {
  return path.join(__dirname, 'data', 'users', String(chatId));
}

function pfad(chatId) {
  return path.join(userVerzeichnis(chatId), 'rate.json');
}

function ladeState(chatId) {
  const p = pfad(chatId);
  if (!fs.existsSync(p)) {
    return { hourStart: 0, hourCount: 0, dayStart: 0, dayCount: 0, toolCount: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { hourStart: 0, hourCount: 0, dayStart: 0, dayCount: 0, toolCount: 0 };
  }
}

function speichereState(chatId, state) {
  fs.mkdirSync(userVerzeichnis(chatId), { recursive: true });
  fs.writeFileSync(pfad(chatId), JSON.stringify(state, null, 2), 'utf-8');
}

function zuruecksetzenWennNeuerZeitraum(state, jetztMs) {
  const eineStundeMs = 60 * 60 * 1000;
  const einTagMs = 24 * eineStundeMs;
  if (jetztMs - state.hourStart >= eineStundeMs) {
    state.hourStart = jetztMs;
    state.hourCount = 0;
  }
  if (jetztMs - state.dayStart >= einTagMs) {
    state.dayStart = jetztMs;
    state.dayCount = 0;
    state.toolCount = 0;
  }
}

// Prüft, ob der User eine Nachricht schicken darf. Liefert {ok, grund}.
// Bei ok=true: zaehleNachricht() aufrufen, um den Zähler zu inkrementieren.
function pruefeNachricht(chatId) {
  const state = ladeState(chatId);
  const jetztMs = Date.now();
  zuruecksetzenWennNeuerZeitraum(state, jetztMs);
  if (state.hourCount >= LIMITS.msgsPerHour) {
    return {
      ok: false,
      grund: `Stundenlimit erreicht (${LIMITS.msgsPerHour} Nachrichten/Stunde). Versuch's in einer Stunde nochmal.`
    };
  }
  if (state.dayCount >= LIMITS.msgsPerDay) {
    return {
      ok: false,
      grund: `Tageslimit erreicht (${LIMITS.msgsPerDay} Nachrichten/Tag). Versuch's morgen wieder.`
    };
  }
  return { ok: true };
}

function zaehleNachricht(chatId) {
  const state = ladeState(chatId);
  const jetztMs = Date.now();
  zuruecksetzenWennNeuerZeitraum(state, jetztMs);
  state.hourCount++;
  state.dayCount++;
  speichereState(chatId, state);
}

function pruefeToolCall(chatId) {
  const state = ladeState(chatId);
  const jetztMs = Date.now();
  zuruecksetzenWennNeuerZeitraum(state, jetztMs);
  if (state.toolCount >= LIMITS.toolCallsPerDay) {
    return {
      ok: false,
      grund: `Tool-Tageslimit erreicht (${LIMITS.toolCallsPerDay}/Tag). Web-Recherche geht heute nicht mehr.`
    };
  }
  return { ok: true };
}

function zaehleToolCall(chatId, anzahl = 1) {
  const state = ladeState(chatId);
  const jetztMs = Date.now();
  zuruecksetzenWennNeuerZeitraum(state, jetztMs);
  state.toolCount += anzahl;
  speichereState(chatId, state);
}

function status(chatId) {
  const state = ladeState(chatId);
  return {
    stunde: state.hourCount + ' / ' + LIMITS.msgsPerHour,
    tag: state.dayCount + ' / ' + LIMITS.msgsPerDay,
    tools: state.toolCount + ' / ' + LIMITS.toolCallsPerDay
  };
}

module.exports = { LIMITS, pruefeNachricht, zaehleNachricht, pruefeToolCall, zaehleToolCall, status };
