// Mistral OCR: wandelt Fotos, Screenshots und PDFs in Text/Markdown um.
// Erfordert MISTRAL_API_KEY in der .env.
const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';

async function mistralOCR(base64Data, mimeType) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) {
    throw new Error('MISTRAL_API_KEY fehlt in der .env.');
  }

  const istPdf = mimeType === 'application/pdf';
  const document = istPdf
    ? { type: 'document_url', document_url: `data:${mimeType};base64,${base64Data}` }
    : { type: 'image_url', image_url: `data:${mimeType};base64,${base64Data}` };

  const res = await fetch(MISTRAL_OCR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({ model: 'mistral-ocr-latest', document })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('Mistral-OCR-Fehler: ' + JSON.stringify(data));
  }

  const text = (data.pages || []).map((p) => p.markdown || '').join('\n\n');
  return text;
}

module.exports = { mistralOCR };
