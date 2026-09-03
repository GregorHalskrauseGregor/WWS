// OCR über Mistral. Wandelt Fotos, Screenshots und PDFs in Text/Markdown.
const { mistralOCR } = require('../../ocr');

module.exports = {
  name: 'mistral',
  verfuegbar: () => !!process.env.MISTRAL_API_KEY,
  benoetigt: 'MISTRAL_API_KEY',
  ausfuehren: async (buffer, mimeType) => mistralOCR(buffer.toString('base64'), mimeType)
};
