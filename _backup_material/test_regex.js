const text = `Material aus dem Auftrag Müller zurück:
3 Kugelhähne DN20 gebraucht
12m Kupferrohr 22mm neu
2 Pressfittinge 18mm neu`;
const zeilen = text.split(/[\n;]+/);
for (const zeileRaw of zeilen) {
  const zeile = zeileRaw.trim();
  if (!zeile || zeile.length < 5) continue;
  const m = zeile.match(/^(\d+(?:[,.]\d+)?)\s*(m\b|cm\b|mm\b|stk\.?|stück|st\.?|lfm|kg|liter|l|pauschal)?\s+(.+)/i);
  if (m) {
    console.log('MATCH:', zeile);
    console.log('  m[1]=', JSON.stringify(m[1]), '  m[2]=', JSON.stringify(m[2]), '  m[3]=', JSON.stringify(m[3]));
  } else {
    console.log('NO MATCH:', zeile);
  }
}
