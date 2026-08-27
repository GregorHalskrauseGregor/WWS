require('dotenv').config();
const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EXCEL_PATH = path.join(__dirname, 'data', 'arbeitsdatei.xlsx');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Liest das erste Tabellenblatt und gibt Workbook + Inhalt als Text zurück
async function readSheetAsText() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);
  const sheet = workbook.worksheets[0];

  let text = `Tabellenblatt: ${sheet.name}\n`;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      text += `${cell.address}: ${cell.value}\n`;
    });
  });

  return { workbook, sheet, text };
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Keine Nachricht übermittelt.' });
    }

    const { workbook, sheet, text } = await readSheetAsText();

    const systemPrompt = `Du bearbeitest eine Excel-Tabelle für einen Handwerksbetrieb.
Aktueller Inhalt der Tabelle:
${text}

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in dieser Form, ohne zusätzlichen Text davor oder danach:
{"changes":[{"cell":"B2","value":123}],"antwort":"Kurze Antwort an den Nutzer"}

Wenn keine Zelle geändert werden soll, gib "changes" als leeres Array zurück.
Ändere nur Zellen, die der Nutzer sinngemäß angefragt hat.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    const raw = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      // KI hat kein valides JSON geliefert -> Antwort trotzdem anzeigen, nichts ändern
      return res.json({ reply: raw, changes: [] });
    }

    if (Array.isArray(parsed.changes) && parsed.changes.length > 0) {
      for (const change of parsed.changes) {
        sheet.getCell(change.cell).value = change.value;
      }
      await workbook.xlsx.writeFile(EXCEL_PATH);
    }

    res.json({
      reply: parsed.antwort || 'Erledigt.',
      changes: parsed.changes || []
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fehler bei der Verarbeitung.' });
  }
});

app.get('/api/download', (req, res) => {
  res.download(EXCEL_PATH, 'arbeitsdatei.xlsx');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
