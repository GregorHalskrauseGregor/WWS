// MiniMax-Provider. Erwartet MINIMAX_API_KEY und optional MINIMAX_MODEL bzw. MINIMAX_MODEL_LIGHT.
//
// Tool-Use: MiniMax-Modelle geben Tool-Calls in einem proprietären XML-Format
// zurück, das hier geparst wird. Beispiel:
//
//   <minimax:tool_call>
//   <invoke name="web_search">
//   <parameter name="query">Photosynthese</parameter>
//   <parameter name="max_results">5</parameter>
//   </invoke>
//   </minimax:tool_call>
//
// Wir senden die Tool-Definitionen im OpenAI-kompatiblen Format — MiniMax
// akzeptiert dieses Schema. Der System-Prompt weist das Modell an, die
// angebotenen Tool-Namen (web_search, web_fetch) zu verwenden.

const { toolsFuerOpenAI } = require('../tools');

const DEFAULT_MODEL = 'MiniMax-M2';
const LIGHT_MODEL = 'MiniMax-M2-mini';

// Mapping bekannter MiniMax-Tool-Namen auf unsere. Falls das Modell im
// Training andere Namen gelernt hat, mappen wir sie hier auf unsere Tools.
const TOOL_NAME_MAP = {
  'web_search': 'web_search',
  'ddg-search_search': 'web_search',
  'search': 'web_search',
  'web_fetch': 'web_fetch',
  'fetch': 'web_fetch',
  'url_fetch': 'web_fetch',
  'jina-fetch': 'web_fetch'
};

function mappeToolName(name) {
  return TOOL_NAME_MAP[name] || name;
}

// Parst Tool-Call-XML-Blöcke aus dem Antworttext. Gibt Array von
// {id, name, args} zurück, oder null wenn keiner gefunden.
function parseXMLToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  // Match <minimax:tool_call>...</minimax:tool_call>-Blöcke (global, multiline)
  const blockRegex = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/g;
  const blocks = [];
  let m;
  while ((m = blockRegex.exec(text)) !== null) {
    blocks.push(m[1]);
  }
  if (blocks.length === 0) return null;

  const calls = [];
  blocks.forEach((inner, i) => {
    // Pro Block: erstes <invoke name="...">...</invoke>
    const invokeMatch = inner.match(/<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/);
    if (!invokeMatch) return;
    const originalName = invokeMatch[1];
    const name = mappeToolName(originalName);
    const body = invokeMatch[2];

    // Parameter extrahieren
    const args = {};
    const paramRegex = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = paramRegex.exec(body)) !== null) {
      let val = pm[2].trim();
      // Zahlen und Booleans nach Möglichkeit konvertieren, falls das Modell
      // sie als nackte Werte schickt.
      if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
      else if (/^-?\d+\.\d+$/.test(val)) val = parseFloat(val);
      else if (val === 'true') val = true;
      else if (val === 'false') val = false;
      args[pm[1]] = val;
    }
    calls.push({
      id: 'minimax-tc-' + i + '-' + Date.now(),
      name,
      args,
      originalName: originalName !== name ? originalName : undefined
    });
  });

  return calls.length > 0 ? calls : null;
}

// Entfernt die XML-Tool-Call-Blöcke aus dem Text, damit nur die natürlich-
// sprachliche Antwort übrig bleibt.
function entferneXMLToolCalls(text) {
  if (!text) return text;
  return text.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
}

async function chat(systemPrompt, userMessage, options = {}) {
  const istLight = options.rolle === 'light';
  const model = options.model
    || (istLight ? process.env.MINIMAX_MODEL_LIGHT : process.env.MINIMAX_MODEL)
    || (istLight ? LIGHT_MODEL : DEFAULT_MODEL);
  const maxTokens = options.maxTokens || (istLight ? 500 : 2000);

  // Messages-Liste wird vom Bot-Loop aufgebaut, wenn Tools im Spiel sind.
  const messages = Array.isArray(options.messages) && options.messages.length > 0
    ? options.messages
    : [{ role: 'user', content: userMessage }];

  // MiniMax-API erwartet System-Prompt im messages-Array.
  const alle = [{ role: 'system', content: systemPrompt }, ...messages];

  const body = {
    model,
    max_tokens: maxTokens,
    messages: alle
  };

  // Tools im OpenAI-kompatiblen Format anbieten — MiniMax akzeptiert das.
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = toolsFuerOpenAI(options.tools);
    // tool_choice 'auto' ist der Standard; 'any' würde das Modell ZWINGEN,
    // ein Tool zu nutzen. Wir lassen es bei auto.
  }

  const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('MiniMax-API-Fehler: ' + JSON.stringify(data).slice(0, 500));
  }

  const message = data.choices?.[0]?.message || {};
  const rawContent = message.content || '';

  // Tool-Calls parsen (entweder aus message.tool_calls ODER aus dem XML im Content)
  let toolCalls = null;

  // 1) Falls MiniMax nativ tool_calls-Feld liefert (OpenAI-kompatibel), nutzen.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    toolCalls = message.tool_calls.map((tc) => ({
      id: tc.id,
      name: mappeToolName(tc.function.name),
      args: parseArgs(tc.function.arguments)
    }));
  }

  // 2) Andernfalls aus dem XML im Content extrahieren.
  if (!toolCalls) {
    toolCalls = parseXMLToolCalls(rawContent);
  }

  // 3) Wenn Tool-Calls gefunden, den XML-Block aus dem sichtbaren Text entfernen,
  //    damit der User den nicht sieht.
  let content = rawContent;
  if (toolCalls && toolCalls.some((c) => c.originalName || /minimax:tool_call/.test(rawContent))) {
    content = entferneXMLToolCalls(rawContent);
  }

  return { content, toolCalls };
}

function parseArgs(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = { chat, DEFAULT_MODEL, LIGHT_MODEL, supportsTools: true, parseXMLToolCalls };
