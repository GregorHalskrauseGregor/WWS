// Transkription von Sprachnachrichten über AssemblyAI (Batch/Pre-recorded, EU-Endpunkt).
// Erfordert ASSEMBLYAI_API_KEY in der .env.
// Ablauf: Audio hochladen -> Transkription anfordern -> auf Ergebnis warten (Polling).
// Keine Längenbeschränkung wie bei Azures Kurzaudio-API -> geeignet auch für Aufnahmen bis 10 Minuten.

const BASE_URL = process.env.ASSEMBLYAI_BASE_URL || 'https://api.eu.assemblyai.com';

async function warte(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transkribiere(audioBuffer) {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    throw new Error('ASSEMBLYAI_API_KEY fehlt in der .env.');
  }

  // 1. Audio hochladen
  const uploadRes = await fetch(`${BASE_URL}/v2/upload`, {
    method: 'POST',
    headers: {
      'authorization': key,
      'content-type': 'application/octet-stream'
    },
    body: audioBuffer
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) {
    throw new Error('AssemblyAI-Upload-Fehler: ' + JSON.stringify(uploadData));
  }

  // 2. Transkription anfordern
  const transcriptRes = await fetch(`${BASE_URL}/v2/transcript`, {
    method: 'POST',
    headers: {
      'authorization': key,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      audio_url: uploadData.upload_url,
      language_code: 'de'
    })
  });
  const transcriptData = await transcriptRes.json();
  if (!transcriptRes.ok) {
    throw new Error('AssemblyAI-Transkriptions-Fehler: ' + JSON.stringify(transcriptData));
  }

  // 3. Auf Ergebnis warten (Polling). Bei 10-Minuten-Aufnahmen dauert die Verarbeitung
  // typischerweise deutlich kürzer als die Aufnahme selbst, aber Puffer nach oben eingebaut.
  const transcriptId = transcriptData.id;
  const maxVersuche = 150; // bei 2s Abstand ca. 5 Minuten Zeitpuffer
  for (let i = 0; i < maxVersuche; i++) {
    await warte(2000);
    const statusRes = await fetch(`${BASE_URL}/v2/transcript/${transcriptId}`, {
      headers: { 'authorization': key }
    });
    const statusData = await statusRes.json();

    if (statusData.status === 'completed') {
      return statusData.text;
    }
    if (statusData.status === 'error') {
      throw new Error('AssemblyAI-Transkription fehlgeschlagen: ' + statusData.error);
    }
    // sonst: status ist "queued" oder "processing" -> weiter warten
  }

  throw new Error('Zeitüberschreitung bei der Transkription.');
}

module.exports = { transkribiere };
