// Transkription über AssemblyAI (EU-Endpunkt, DSGVO-konform, auch lange Aufnahmen).
const { transkribiere } = require('../../transcribe');

module.exports = {
  name: 'assemblyai',
  verfuegbar: () => !!process.env.ASSEMBLYAI_API_KEY,
  benoetigt: 'ASSEMBLYAI_API_KEY',
  ausfuehren: async (buffer) => transkribiere(buffer)
};
