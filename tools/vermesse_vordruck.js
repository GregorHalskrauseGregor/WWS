// Misst den Zienert-Vordruck aus und gibt die Zahlen aus, die in
// lib/aufmass_layout.js stehen. Zum Nachrechnen, wenn Zienert eine neue
// Vorlage liefert.
//
//   node tools/vermesse_vordruck.js
//
// Braucht pdftoppm (poppler) und Python mit Pillow/numpy. Fehlt eins davon,
// sagt das Skript das und bricht ab — Layoutzahlen zu raten waere schlimmer,
// als sie von Hand zu messen.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VORDRUCK = path.join(__dirname, '..', 'data', 'aufnahme_vorlage', 'Aufmass_Zienert_vordruck.pdf');

const PY = `
from PIL import Image
import numpy as np, sys
im = Image.open(sys.argv[1]).convert('L')
a = np.asarray(im).astype(np.int16); H, W = a.shape; P = 595.276 / W
# Zwei Schwellen: die Tabellenlinien sind hellgrau gedruckt (~230), Text ist
# dunkel. Fuer die Linienerkennung braucht es die weiche Schwelle, sonst fallen
# ganze Zeilen aus dem Raster.
d = a < 238
def gr(idx, l=3):
    g = []
    for i in idx:
        if g and i - g[-1][-1] <= l: g[-1].append(i)
        else: g.append([i])
    return [(x[0]+x[-1])/2 for x in g]
# Nur Linien zaehlen, die WIRKLICH quer ueber die Tabelle laufen: von der
# linken zur rechten Rahmenlinie. Sonst rutscht der Unterstrich von
# "Bauvorhaben" als vermeintliche Tabellenoberkante mit hinein.
x1, x2 = int(56/P), int(578/P)
def quer(y):
    return d[y, x1:x2].sum() > (x2-x1)*0.9
z = d.sum(axis=1)
linien = sorted([(H-y)*P for y in gr([y for y in range(H) if quer(y)])], reverse=True)
tab = [l for l in linien if 90 < l < 780]
# Eine der Zeilenlinien ist heller gedruckt als die anderen und faellt auch
# bei weicher Schwelle durch. Statt die Schwelle immer weiter aufzuweichen
# (dann kommt Text als Linie mit), wird eine Luecke von rund zwei Zeilenhoehen
# aufgefuellt: dort MUSS eine Linie sein, sonst waere die Tabelle unregelmaessig.
abst = sorted(tab[i]-tab[i+1] for i in range(1, len(tab)-1))
grund = abst[len(abst)//2]
voll = [tab[0]]
for i in range(1, len(tab)):
    luecke = voll[-1] - tab[i]
    n = round(luecke / grund)
    for k in range(1, n):
        voll.append(voll[-1] - luecke/n)
    voll.append(tab[i])
tab = voll
print('TABELLE oben=%.2f kopfzeileBis=%.2f unten=%.2f zeilen=%d' % (tab[0], tab[1], tab[-1], len(tab)-2))
abst = [tab[i]-tab[i+1] for i in range(1, len(tab)-1)]
print('zeilenHoehe=%.2f (min %.2f max %.2f)' % (sum(abst)/len(abst), min(abst), max(abst)))
oben, unten = int(H-tab[0]/P), int(H-tab[-1]/P)
sp = d[oben:unten, :].sum(axis=0)
vs = gr([x for x in range(W) if sp[x] > (unten-oben)*0.8])
print('SPALTEN_X = [' + ', '.join('%.2f' % (x*P) for x in vs) + ']')
`;

function haupt() {
  if (!fs.existsSync(VORDRUCK)) {
    console.error(`Vordruck fehlt: ${VORDRUCK}`);
    console.error('Erzeugen mit: node tools/erzeuge_vordruck.js');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vermessung-'));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '300', '-gray', '-f', '1', '-l', '1',
      VORDRUCK, path.join(tmp, 'seite')], { stdio: 'pipe' });
  } catch {
    console.error('pdftoppm fehlt (Paket poppler-utils). Ohne Renderer keine Messung.');
    process.exit(1);
  }
  const bild = fs.readdirSync(tmp).find((f) => f.endsWith('.png'));
  const skript = path.join(tmp, 'messen.py');
  fs.writeFileSync(skript, PY);
  try {
    console.log(execFileSync('python3', [skript, path.join(tmp, bild)], { encoding: 'utf-8' }));
  } catch (err) {
    console.error('Messung fehlgeschlagen — fehlt Pillow oder numpy?');
    console.error(String(err.stderr || err.message).split('\n').slice(-3).join('\n'));
    process.exit(1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

haupt();
