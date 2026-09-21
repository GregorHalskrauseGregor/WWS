// Self-healing Aktions-Engine fuer den Grosshandel-Bot.
//
// Jede Aktion wird eskalierend versucht:
//   Stufe 1+2: deterministisch — eine LISTE von Selektor-Strategien der Reihe nach
//              (css, text=, role=Name|, idsub, ...). Faengt "Anker stimmt nicht"
//              meist kostenlos ab.
//   Stufe 3a:  KI-DOM (guenstig) — sichtbare Bedienelemente als JSON an Claude,
//              Claude nennt das passende Element + robusten Selektor.
//   Stufe 3b:  KI-Vision (fuer Icons / wenn DOM nicht reicht) — Screenshot an
//              Claude, Claude gibt Klick-Koordinaten zurueck.
// Nach JEDEM Schritt Verifikation (erwarteter Folgezustand sichtbar?).
// Findet die KI einen funktionierenden Selektor, wird er per heal()-Callback
// zurueckgeschrieben (Selbstheilung) — beim naechsten Mal wieder Stufe 1.

// ---------------------------------------------------------------- Locator-Strategien
function locatorFromKandidat(page, k) {
  if (typeof k !== 'string' || !k.trim()) return null;
  if (k.startsWith('text='))       return page.getByText(k.slice(5), { exact: false }).first();
  if (k.startsWith('exacttext='))  return page.getByText(k.slice(10), { exact: true }).first();
  if (k.startsWith('role=')) {
    const [role, name] = k.slice(5).split('|');
    return name ? page.getByRole(role, { name, exact: false }).first()
                : page.getByRole(role).first();
  }
  if (k.startsWith('placeholder=')) return page.getByPlaceholder(k.slice(12)).first();
  if (k.startsWith('label='))       return page.getByLabel(k.slice(6)).first();
  if (k.startsWith('css='))         return page.locator(k.slice(4)).first();
  return page.locator(k).first(); // default: als CSS behandeln
}

async function klick(loc) {
  // Erst normaler Klick mit kurzem Timeout; haengt GCs Modal in der
  // Actionability-Pruefung (unsichtbare Ueberlagerung/Instabilitaet), fassen wir
  // mit force nach — das klickt den Button direkt und umgeht die Hit-Test-Pruefung.
  try {
    await loc.click({ timeout: 8000 });
  } catch {
    await loc.click({ force: true, timeout: 8000 });
  }
}

async function fuehreAus(page, loc, aktion, wert) {
  if (aktion === 'fill' || aktion === 'type') {
    // WICHTIG: GCs A3-Commerce-Framework liest Eingaben ueber ECHTE Tastatur-
    // Events mit. locator.fill() setzt nur .value + ein input-Event — das
    // Framework bekommt den Wert NICHT mit und schickt das Formular mit leeren
    // Pflichtfeldern ab. Genau das war der Login-Fehler 11221777 und der Grund,
    // warum der Warenkorb-Dialog sich ohne Anlegen wieder schloss.
    // Deshalb: fokussieren, leeren, Zeichen fuer Zeichen tippen, Tab (change).
    await klick(loc);
    await loc.fill('').catch(() => {});
    await loc.pressSequentially(String(wert ?? ''), { delay: 35 });
    await loc.press('Tab').catch(() => {});
    return;
  }
  await klick(loc);
}

async function verify(page, erwarteDanach, timeout = 12000) {
  if (!erwarteDanach) return true; // nichts zu pruefen -> als ok werten
  return page.locator(erwarteDanach).first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true).catch(() => false);
}

async function resolveDeterministisch(page, kandidaten, timeoutEach = 2500) {
  for (const k of kandidaten || []) {
    const loc = locatorFromKandidat(page, k);
    if (!loc) continue;
    const ok = await loc.waitFor({ state: 'visible', timeout: timeoutEach })
      .then(() => true).catch(() => false);
    if (ok) return { loc, kandidat: k };
  }
  return null;
}

// ---------------------------------------------------------------- DOM-Snapshot
async function domSnapshot(page) {
  return page.evaluate(() => {
    const sel = 'a,button,input,select,textarea,[role="button"],[role="menuitem"],[onclick],[tabindex]';
    const els = Array.from(document.querySelectorAll(sel));
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') continue;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      out.push({
        i: out.length,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        name: el.getAttribute('name') || '',
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        text,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      });
      if (out.length >= 150) break;
    }
    return out;
  }).catch(() => []);
}

// ---------------------------------------------------------------- Anthropic
function pngSize(buf) {
  try { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
  catch { return null; }
}

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Austauschbarer LLM-Aufruf. provider='openai' = OpenAI-kompatibles Schema
// (MiniMax, Mistral, OpenAI, ...); provider='anthropic' = Anthropic-Schema.
// Bild optional (imageB64) fuer die Vision-Stufe.
async function llm(ai, { text, imageB64 }, maxTokens = 300, useVisionModel = false) {
  const model = (useVisionModel && ai.visionModel) ? ai.visionModel : ai.model;

  if (ai.provider === 'anthropic') {
    const content = imageB64
      ? [{ type: 'text', text },
         { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } }]
      : text;
    const res = await fetch(ai.baseUrl || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
    });
    if (!res.ok) throw new Error(`KI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const d = await res.json();
    return (d.content || []).map(c => c.text || '').join('');
  }

  // OpenAI-kompatibel (Standard): messages mit content-Teilen, Bild als data-URL.
  const content = imageB64
    ? [{ type: 'text', text },
       { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } }]
    : text;
  const res = await fetch(ai.baseUrl, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${ai.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
  });
  if (!res.ok) throw new Error(`KI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const d = await res.json();
  const msg = d?.choices?.[0]?.message?.content;
  if (Array.isArray(msg)) return msg.map(x => x.text || '').join('');
  return msg || '';
}

async function askDom(ziel, elemente, ai) {
  const prompt =
    `Du hilfst einem Browser-Automaten auf der SHK-Grosshandels-Seite gconlineplus.de.\n` +
    `ZIEL: ${ziel}\n\n` +
    `Sichtbare, klickbare Elemente der Seite als JSON (i = Index):\n` +
    `${JSON.stringify(elemente)}\n\n` +
    `Waehle das Element, das dem ZIEL am besten entspricht. Gib einen ROBUSTEN ` +
    `Playwright-Selektor zurueck: bevorzugt "text=..." oder "role=rolle|Name"; ` +
    `nutze "#id" NUR, wenn die id keine wechselnden Ziffernbloecke enthaelt ` +
    `(z. B. a792 ist instabil). Wenn nichts passt: index -1.\n` +
    `Antworte NUR mit JSON: {"index": <i|-1>, "selector": "<selektor|>", "reason": "<kurz>"}`;
  return extractJson(await llm(ai, { text: prompt }, 250, false));
}

async function askVision(ziel, pngBuf, ai) {
  const size = pngSize(pngBuf) || { w: 0, h: 0 };
  const prompt =
    `Du steuerst einen Browser auf gconlineplus.de per Mausklick.\n` +
    `ZIEL: ${ziel}\n` +
    `Der Screenshot ist ${size.w}x${size.h} Pixel gross. Finde das anzuklickende ` +
    `Element und gib den Klickpunkt in Pixeln (bezogen auf dieses Bild) zurueck.\n` +
    `Antworte NUR mit JSON: {"found": true|false, "x": <px>, "y": <px>, "reason": "<kurz>"}`;
  const r = extractJson(await llm(ai, { text: prompt, imageB64: pngBuf.toString('base64') }, 200, true));
  if (r) r._imgW = size.w;
  return r;
}

// ---------------------------------------------------------------- Kern: act()
async function act(page, spec, ctx) {
  const { log, shot, ai, heal } = ctx;
  const { key, ziel, kandidaten = [], aktion = 'click', wert, erwarteDanach, icon = false } = spec;

  // --- Stufe 1+2: deterministisch (mehrere Strategien) ---
  const det = await resolveDeterministisch(page, kandidaten);
  if (det) {
    await fuehreAus(page, det.loc, aktion, wert).catch(() => {});
    if (await verify(page, erwarteDanach)) {
      log(`OK ${key} (deterministisch: ${det.kandidat})`);
      return { ok: true, via: 'det', kandidat: det.kandidat };
    }
    log(`~ ${key}: "${det.kandidat}" ausgefuehrt, Folgezustand fehlt -> KI.`);
  } else {
    log(`~ ${key}: kein deterministischer Treffer -> KI.`);
  }

  if (!ai || !ai.enabled) {
    throw new Error(`Aktion "${key}" (${ziel}) fehlgeschlagen; KI-Fallback ist aus (AI_API_KEY / AI_MODEL / AI_BASE_URL setzen).`);
  }
  if (ai.used >= ai.budget) {
    throw new Error(`Aktion "${key}" (${ziel}) fehlgeschlagen; KI-Budget (${ai.budget} Schritte) erschoepft.`);
  }

  // --- Stufe 3a: KI-DOM (guenstig) — nicht bei reinen Icon-Zielen ---
  if (!icon) {
    ai.used++;
    const snap = await domSnapshot(page);
    const r = await askDom(ziel, snap, ai).catch(e => { log(`KI-DOM Fehler: ${e.message}`); return null; });
    if (r) {
      let via = null, healSel = null;
      if (r.selector) {
        const loc = page.locator(r.selector).first();
        if (await loc.isVisible().catch(() => false)) {
          await fuehreAus(page, loc, aktion, wert).catch(() => {});
          via = `KI-DOM ${r.selector}`; healSel = r.selector;
        }
      }
      if (!via && Number.isInteger(r.index) && r.index >= 0 && snap[r.index]) {
        const e = snap[r.index];
        await page.mouse.click(e.x, e.y);
        if (aktion === 'fill' || aktion === 'type') await page.keyboard.type(String(wert ?? ''));
        via = `KI-DOM Koordinaten #${r.index}`;
      }
      if (via && await verify(page, erwarteDanach)) {
        log(`OK ${key} (${via})`);
        if (healSel) await heal(key, healSel);
        return { ok: true, via: 'ai-dom', selector: healSel };
      }
      if (via) log(`~ ${key}: ${via} ausgefuehrt, Folgezustand fehlt -> Vision.`);
    }
  }

  // --- Stufe 3b: KI-Vision (Screenshot -> Koordinaten) ---
  if (ai.vision && ai.used < ai.budget) {
    ai.used++;
    try { await shot(`ki-vision-${key}`); } catch { /* egal */ }
    const png = await page.screenshot();
    const v = await askVision(ziel, png, ai).catch(e => { log(`KI-Vision Fehler: ${e.message}`); return null; });
    if (v && v.found) {
      const inner = await page.evaluate(() => ({ w: window.innerWidth })).catch(() => ({ w: v._imgW }));
      const ratio = (v._imgW && inner.w) ? inner.w / v._imgW : 1;
      const cx = Math.round(v.x * ratio), cy = Math.round(v.y * ratio);
      await page.mouse.click(cx, cy);
      if (aktion === 'fill' || aktion === 'type') await page.keyboard.type(String(wert ?? ''));
      if (await verify(page, erwarteDanach)) {
        log(`OK ${key} (KI-Vision @${cx},${cy})`);
        return { ok: true, via: 'ai-vision' };
      }
      log(`~ ${key}: KI-Vision @${cx},${cy} geklickt, Folgezustand fehlt.`);
    }
  }

  throw new Error(`Aktion "${key}" (${ziel}) nicht ausfuehrbar — deterministisch und KI gescheitert.`);
}

export { act, resolveDeterministisch, locatorFromKandidat, domSnapshot };
