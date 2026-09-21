// HTTP-Zugang für den Laptop-Agenten.
//
// Das ist die einzige Tür, die die Hetzner-Box für den Laptop öffnet. Sie ist
// bewusst winzig: vier Endpunkte, ein Token, kein Framework. Der Bot selbst
// hat keinen Webserver und soll auch keinen bekommen — hier geht es nur darum,
// Aufträge herauszugeben und Ergebnisse entgegenzunehmen.
//
//   GET  /health                     ohne Token. Kurzer Zustandsbericht.
//   GET  /agent/auftrag?warte=25     Long-Poll. Liefert einen Auftrag oder 204.
//   POST /agent/lebt/:id             "ich arbeite noch" — verlängert die Frist.
//   POST /agent/ergebnis/:id         Ergebnis + optional Screenshots.
//   POST /agent/heartbeat            Lebenszeichen, auch ohne Auftrag.
//
// ══════════════════════════════════════════════════════════════════════════
// ZUR SICHERHEIT — ehrlich gesagt
// ══════════════════════════════════════════════════════════════════════════
//
// Ohne Domain läuft das hier als einfaches HTTP. Der Token wird dann im Klartext
// übertragen; in einem fremden WLAN könnte ihn jemand mitlesen und eigene
// Aufträge einstellen — Bestellungen im GC-Portal also. Die Zugangsdaten zum
// Großhändler gehen NICHT über diese Leitung, die liegen auf dem Laptop.
//
// Wer eine Domain auf die Box zeigen lässt, schaltet in der docker-compose.yml
// den Caddy-Dienst frei und bekommt HTTPS geschenkt. Das ist die empfohlene
// Betriebsart, und die Anleitung beschreibt sie. Ohne Domain bleibt: ein sehr
// langer Token und die Gewissheit, dass es nicht ideal ist.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PFADE } = require('../config');
const auftragsstelle = require('../kern/auftragsstelle');

const MAX_KOERPER = 12 * 1024 * 1024;   // 12 MB, reicht für mehrere Screenshots
const MAX_WARTE_MS = 30_000;
const DATEI_ORDNER = path.join(PFADE.DATA, 'auftraege', 'dateien');

function gleich(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function json(res, code, koerper) {
  const text = JSON.stringify(koerper);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function leseKoerper(req) {
  return new Promise((resolve, reject) => {
    let laenge = 0;
    const teile = [];
    req.on('data', (c) => {
      laenge += c.length;
      if (laenge > MAX_KOERPER) {
        reject(new Error('Anfrage zu groß'));
        req.destroy();
        return;
      }
      teile.push(c);
    });
    req.on('end', () => {
      if (!teile.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(teile).toString('utf-8'))); }
      catch (err) { reject(new Error('Kein gültiges JSON: ' + err.message)); }
    });
    req.on('error', reject);
  });
}

function sicherDateiname(name) {
  return String(name || 'datei')
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\-]/g, '_')
    .slice(0, 80) || 'datei';
}

// Screenshots kommen als base64 mit. Sie landen auf der Box, damit der Bot sie
// an Telegram weiterreichen kann — der Monteur sieht den Warenkorb, ohne an den
// Laptop zu müssen.
function speichereDateien(auftragId, dateien) {
  if (!Array.isArray(dateien) || !dateien.length) return [];
  fs.mkdirSync(DATEI_ORDNER, { recursive: true });
  const pfade = [];
  for (const d of dateien.slice(0, 10)) {
    if (!d || !d.inhaltBase64) continue;
    try {
      const puffer = Buffer.from(d.inhaltBase64, 'base64');
      if (!puffer.length || puffer.length > 10 * 1024 * 1024) continue;
      const ziel = path.join(DATEI_ORDNER, `${auftragId}_${sicherDateiname(d.name)}`);
      fs.writeFileSync(ziel, puffer);
      pfade.push(ziel);
    } catch { /* eine kaputte Datei darf das Ergebnis nicht verhindern */ }
  }
  return pfade;
}

function starte({ port, token, host = '0.0.0.0' } = {}) {
  if (!token) {
    console.warn('Auftragsstelle NICHT gestartet: AGENT_TOKEN fehlt in der .env. ' +
      'Der Laptop kann keine Aufträge abholen — Großhandel-Bestellungen bleiben liegen.');
    return null;
  }
  if (String(token).length < 24) {
    console.warn('WARNUNG: AGENT_TOKEN ist kurz. Er steht offen im Netz — nimm mindestens ' +
      '32 zufällige Zeichen (openssl rand -hex 32).');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const pfad = url.pathname.replace(/\/+$/, '') || '/';

    // Gesundheitsabfrage ohne Token: damit "läuft der Bot überhaupt?" auch
    // beantwortbar ist, ohne ein Geheimnis in die Kommandozeile zu tippen.
    if (req.method === 'GET' && (pfad === '/health' || pfad === '/')) {
      const z = auftragsstelle.zustand();
      return json(res, 200, {
        status: 'ok',
        dienst: 'wws-auftragsstelle',
        warteschlange: { wartet: z.wartet, laeuft: z.laeuft, unklar: z.unklar },
        agent: { online: z.agent.online, zuletzt: z.agent.zuletzt }
      });
    }

    const kopf = req.headers.authorization || '';
    const geliefert = kopf.startsWith('Bearer ') ? kopf.slice(7).trim() : '';
    if (!gleich(geliefert, token)) {
      console.warn(`Auftragsstelle: abgelehnt ${req.method} ${pfad} von ${req.socket.remoteAddress}`);
      // Kleine Verzögerung: macht stumpfes Durchprobieren unattraktiv, ohne
      // einen echten Agenten spürbar zu bremsen.
      await new Promise((r) => setTimeout(r, 400));
      return json(res, 401, { error: 'Token stimmt nicht' });
    }

    const agentId = String(url.searchParams.get('agent') || req.headers['x-agent'] || 'agent').slice(0, 60);

    try {
      // ── Auftrag abholen (Long-Poll)
      if (req.method === 'GET' && pfad === '/agent/auftrag') {
        const warte = Math.min(MAX_WARTE_MS, Math.max(0, Number(url.searchParams.get('warte') || 25) * 1000));
        const a = await auftragsstelle.warteAufAuftrag(agentId, warte);
        if (!a) { res.writeHead(204); return res.end(); }
        return json(res, 200, {
          id: a.id, art: a.art, beschreibung: a.beschreibung,
          nutzlast: a.nutzlast, versuch: a.versuche, leaseBis: a.leaseBis
        });
      }

      // ── "ich arbeite noch"
      const lebt = pfad.match(/^\/agent\/lebt\/([\w-]+)$/);
      if (req.method === 'POST' && lebt) {
        const a = auftragsstelle.verlaengere(lebt[1], agentId);
        if (!a) return json(res, 404, { error: 'Auftrag läuft nicht (mehr)' });
        return json(res, 200, { ok: true, leaseBis: a.leaseBis });
      }

      // ── Ergebnis
      const erg = pfad.match(/^\/agent\/ergebnis\/([\w-]+)$/);
      if (req.method === 'POST' && erg) {
        const koerper = await leseKoerper(req);
        const pfade = speichereDateien(erg[1], koerper.dateien);
        const a = await auftragsstelle.melde(erg[1], {
          ok: koerper.ok === true,
          unklar: koerper.unklar === true,
          ergebnis: { ...(koerper.ergebnis || {}), dateien: pfade },
          fehler: koerper.fehler
        });
        if (!a) return json(res, 404, { error: 'Auftrag unbekannt' });
        return json(res, 200, { ok: true, zustand: a.zustand });
      }

      // ── Lebenszeichen
      if (req.method === 'POST' && pfad === '/agent/heartbeat') {
        const koerper = await leseKoerper(req).catch(() => ({}));
        const z = auftragsstelle.heartbeat(agentId, koerper.info || null);
        return json(res, 200, { ok: true, agent: z, wartet: auftragsstelle.zustand().wartet });
      }

      return json(res, 404, { error: 'Unbekannter Endpunkt' });
    } catch (err) {
      console.error('Auftragsstelle:', err.message);
      return json(res, 400, { error: err.message });
    }
  });

  // Long-Poll: Node soll die Verbindung nicht von sich aus kappen.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;

  server.listen(port, host, () => {
    console.log(`Auftragsstelle hört auf ${host}:${port} — der Laptop-Agent holt hier seine Aufträge ab.`);
  });
  server.on('error', (err) => {
    console.error(`Auftragsstelle konnte Port ${port} nicht öffnen: ${err.message}\n` +
      'Ist der Port schon belegt (zweiter Bot auf der Box)? Dann AGENT_PORT in der .env ändern.');
  });

  return server;
}

module.exports = { starte, DATEI_ORDNER };
