// Sicherheits-Layer für den Bot:
//   - URL-Blacklist: bekannte Exfiltration-/Tracking-Dienste, die ein Angreifer
//     der KI unterjubeln könnte, damit sie Daten "dorthin" schickt.
//   - Output-Filter: filtert verdächtige Muster aus KI-Antworten raus, bevor sie
//     der User zu sehen kriegt (z.B. versehentliche System-Prompt-Leaks,
//     Klartext-API-Keys).
// Bewusst pragmatisch: keine Garantie auf Vollständigkeit, aber blockt die
// typischen Angriffe.

const BLOCKIERTE_DOMAINS = [
  // Exfiltration / Request-Bin-Dienste
  'webhook.site', 'webhook.site.',
  'requestbin.com', 'requestbin.net',
  'pipedream.com', 'requestcatcher.com',
  'interactsh.com', 'interact.sh',
  'canarytokens.com',
  'dnslog.cn', 'ceye.io', 'oastify.com', 'oast.pro',
  'burpcollaborator.net',
  // Tunneling-Dienste (oft für versteckte Endpoints)
  'ngrok.io', 'ngrok.app',
  'serveo.net',
  'localtunnel.me',
  // Anonyme File-Sharing-Dienste (oft für schädliche Payloads)
  'transfer.sh',
  'pastebin.com', 'paste.debian.net', 'ghostbin.com',
  // URL-Shortener (verschleiern das Ziel)
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly'
];

// Prüft, ob eine URL gegen die Blacklist verstößt. Wir matchen auf exakte Domain
// und auf Subdomains (z.B. "evil.webhook.site" wäre auch blockiert).
function istBlockierteUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { blockiert: true, grund: 'ungültige URL' };
  }
  // Nur http/https erlauben — javascript:, data:, file: etc. wären Exfiltration-Vektoren.
  if (!/^https?:$/i.test(u.protocol)) {
    return { blockiert: true, grund: 'Protokoll nicht erlaubt: ' + u.protocol };
  }
  const host = u.hostname.toLowerCase();
  for (const blocked of BLOCKIERTE_DOMAINS) {
    if (host === blocked || host.endsWith('.' + blocked)) {
      return { blockiert: true, grund: 'Domain geblockt: ' + host };
    }
  }
  return { blockiert: false };
}

// Muster, die in KI-Antworten NICHT auftauchen sollten. Werden vor dem Senden
// an den User durch [INHALT GEFILTERT] ersetzt.
const VERDAECHTIGE_OUTPUT_MUSTER = [
  // Direkte Versuche, den System-Prompt zu leaken
  /mein\s+system[- ]?prompt\s+(ist|lautet|sieht\s+so\s+aus)[:\s]/gi,
  /my\s+system\s+prompt\s+(is|reads|looks\s+like)[:\s]/gi,
  /hier\s+ist\s+(mein|der|das)\s+system[- ]?prompt/gi,
  /here\s+is\s+my\s+system\s+prompt/gi,
  /laut\s+meinen?\s+(anweisungen|regeln|instruktionen)/gi,
  /according\s+to\s+my\s+(instructions|rules|system\s+prompt)/gi,
  // Rollenübernahme-Versuche in der Antwort (nicht im User-Input)
  /ich\s+bin\s+(jetzt|nun|ab\s+sofort)\s+(ein|eine|der|die)\s+/gi,
  /from\s+now\s+on\s+i\s+am\s+/gi,
  // MERKE-Hook im sichtbaren Output (sollte nie durchkommen — der Bot filtert den)
  /\[MERKE:[^\]]*\]/gi
];

// Rohe Tool-Call-XML-Blöcke verschiedener Anbieter. Manche Modelle (z.B.
// MiniMax-M2/M3) versuchen, eigene proprietäre Tools in einem XML-Stream
// aufzurufen, den wir nicht verarbeiten. Wenn solche Blöcke im Output landen,
// filtern wir sie raus und ersetzen sie durch eine Hinweismeldung — sonst
// sieht der User unverständliches XML.
const ROHE_TOOL_CALL_BLOCKE = [
  // MiniMax-Variante: <minimax:tool_call> ... <invoke name="..."> ... </invoke> ...
  /<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi,
  // Generische <tool_call>-Blöcke (manche Modelle nutzen das nativ)
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  // <invoke>-Blöcke ohne Wrapper (seltener, aber vorsichtshalber)
  /<invoke\s+name=["'][^"']+["']>[\s\S]*?<\/invoke>/gi
];

// API-Key-Formate, die niemals im Klartext an einen User gehen dürften.
// Wir matchen auf typische Prefix-Formen, nicht auf beliebige lange Strings.
const API_KEY_MUSTER = [
  // Anthropic: sk-ant-...
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI: sk-... (aber nicht sk-ant-...)
  /(?<!sk-ant-)sk-[A-Za-z0-9]{32,}/g,
  // Tavily: tvly-...
  /tvly-[A-Za-z0-9]{20,}/g,
  // Jina: jina_...
  /jina_[A-Za-z0-9]{20,}/g,
  // MiniMax API-Keys (oft lange Random-Strings mit Bindestrich)
  /eyJ[A-Za-z0-9_-]{40,}/g, // generisches JWT-Format, falls MiniMax das nutzt
  // Telegram-Bot-Tokens
  /\d{8,10}:[A-Za-z0-9_-]{35}/g
];

// Env-Variablennamen, die im Klartext in Outputs nichts zu suchen haben.
const ENV_SECRET_MUSTER = [
  /(?:^|[\s,;])(ANTHROPIC_API_KEY|OPENAI_API_KEY|TAVILY_API_KEY|JINA_API_KEY|MINIMAX_API_KEY|ASSEMBLYAI_API_KEY|MISTRAL_API_KEY|TELEGRAM_BOT_TOKEN)\s*=\s*[^\s,;\n]+/gi
];

function filterOutput(text) {
  if (!text || typeof text !== 'string') return { text, gefiltert: [], hinweis: null };
  let result = text;
  const gefiltert = [];
  let hinweis = null;

  // 1) Rohe Tool-Call-XML-Blöcke rauswerfen + Hinweis vorbereiten.
  //    Manche Modelle versuchen, eigene proprietäre Tools im XML-Format
  //    aufzurufen — wir verarbeiten das nicht, also muss der User das nicht
  //    sehen, sondern eine sinnvolle Erklärung kriegen.
  for (const pattern of ROHE_TOOL_CALL_BLOCKE) {
    if (pattern.test(result)) {
      gefiltert.push('roher Tool-Call-Block (Modell wollte Tool aufrufen, das wir nicht unterstützen)');
      result = result.replace(pattern, '').trim();
      if (!hinweis) {
        hinweis = '⚠️ Das Modell hat versucht, ein eigenes Tool aufzurufen, das auf diesem Provider nicht verfügbar ist. ' +
          'Für Web-Recherche braucht der Bot `AI_PROVIDER=anthropic` oder `AI_PROVIDER=openai` in der `.env`.';
      }
    }
  }

  for (const pattern of VERDAECHTIGE_OUTPUT_MUSTER) {
    if (pattern.test(result)) {
      gefiltert.push('verdächtiges Muster: ' + pattern.source);
      result = result.replace(pattern, '[INHALT GEFILTERT]');
    }
  }
  for (const pattern of API_KEY_MUSTER) {
    const matches = result.match(pattern);
    if (matches) {
      gefiltert.push(...matches.map((m) => 'API-Key: ' + m.slice(0, 8) + '…'));
      result = result.replace(pattern, '[API-KEY GEFILTERT]');
    }
  }
  for (const pattern of ENV_SECRET_MUSTER) {
    const matches = result.match(pattern);
    if (matches) {
      gefiltert.push(...matches);
      result = result.replace(pattern, '[UMGEBUNGSVARIABLE GEFILTERT]');
    }
  }

  return { text: result.trim(), gefiltert, hinweis };
}

module.exports = {
  BLOCKIERTE_DOMAINS,
  ROHE_TOOL_CALL_BLOCKE,
  istBlockierteUrl,
  filterOutput
};
